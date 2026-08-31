# ADR-011 — Retomada automática a partir do Task State

## Status

Aceita em 2026-08-31.

## Contexto

Depois da admissão, o processo podia cair em três pontos seguros mas incompletos:

- `accepted`, antes de iniciar o planejamento;
- `planning`, antes de persistir plano e autorização;
- `ready`, depois de persistir plano e autorização, mas antes de criar a mensagem de execução.

O PostgreSQL preservava corretamente o estado parcial, porém uma nova instância apenas o devolvia.
Ela não calculava a próxima transição. Assim, idempotência impedia a duplicação, mas não garantia
progresso.

## Decisão

1. `Task State` continua sendo a única fonte de verdade do ciclo de vida.
2. O Task Manager possui um reconciliador automático para `accepted`, `planning` e `ready`.
3. Cada reconciliação lê novamente o estado e executa no máximo uma sequência conhecida de três
   transições: `accepted -> planning -> ready -> running`.
4. A passagem `planning -> ready` grava plano, pedido de autorização, decisão e enforcement na mesma
   transação CAS.
5. A passagem `ready -> running` relê esses documentos do banco e confere schemas, fingerprints,
   vínculos e validade antes de criar a outbox.
6. Repetir uma admissão também chama a reconciliação; encontrar a mesma tarefa parcial deixa de ser
   um beco sem saída.
7. O servidor procura tarefas recuperáveis ao iniciar e depois a cada segundo. `work-once` também
   reconcilia antes de consumir a outbox.
8. Uma lease operacional de 30 segundos impede duas instâncias de avançarem a mesma tarefa. A lease
   expira após queda e não cria um segundo status de domínio.
9. Autorizações vencidas nunca são reutilizadas. Renovação de autorização será um fluxo explícito de
   recuperação; até ele existir, o erro permanece visível e a execução não começa.
10. Se o processo cair depois de o Omni responder e antes da transação `planning -> ready`, a consulta
    pode ser repetida, mas sempre com o mesmo `authorizationRequestId` e o mesmo conteúdo. O
    Authority Provider deve tratar essa identidade de modo idempotente; o Overcore nunca inventa um
    segundo pedido para esconder a incerteza.

## Mapa

```text
PostgreSQL
   |
   +-- accepted --claim--> planning
   |                         |
   |                         +--> plano + Omni + enforcement --CAS--> ready
   |                                                                  |
   |                                                                  +--claim + reload--> running + outbox
   |
   `-- lease vencida após queda --> outra instância pode continuar

Dois reconciliadores
   |
   +-- A recebe a lease e avança
   `-- B não recebe a lease e apenas relê o estado
```

## Por que a lease não é outro Task State

A lease responde apenas “qual processo está trabalhando neste registro agora?”. Ela não responde
“em qual fase do trabalho a tarefa está?”. Por isso:

- não aparece no contrato público;
- não acrescenta estado ao grafo;
- pode expirar sem transição de negócio;
- é apagada quando a tarefa sai das fases reconciliáveis.

É a diferença entre reservar a chave de uma sala por alguns segundos e registrar em qual etapa da
obra o edifício se encontra.

## Evidências

- quedas simuladas em `accepted`, `planning` e `ready` retomam até `running`;
- dois reconciliadores concorrentes fazem apenas uma nova consulta ao Authority Provider;
- uma resposta de autoridade perdida pode causar nova chamada, mas o teste comprova que a identidade
  do pedido permanece exatamente a mesma;
- a lease rejeita concorrente antes do prazo e pode ser reivindicada depois da expiração;
- no PostgreSQL real, uma queda em `ready` deixa zero mensagens de outbox; duas novas instâncias
  convergem depois para uma única mensagem;
- plano e autorização persistidos são relidos e revalidados antes do dispatch.

## Consequências

- reiniciar o Overcore deixa de exigir reenviar ou reconstruir a tarefa;
- um estado parcial válido progride sozinho;
- a mesma tarefa, plano e outbox continuam únicos;
- falhas de autoridade e autorizações vencidas permanecem fail-closed e observáveis;
- o próximo bloco é formalizar recuperação de falhas: renovação de autorização, backoff, `blocked`,
  retry e retorno seguro à fase apropriada.
