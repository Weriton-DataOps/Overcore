# Task Manager v1

## Em uma frase

O `Task Manager` administra a vida operacional de uma tarefa do primeiro rascunho até o resultado,
usando contratos e estado persistente. Ele **coordena**; não conversa com o usuário, não concede
permissão e não executa ferramentas.

Uma analogia útil é a de um maestro:

- o Omni entende o que o público quer e entrega a partitura;
- o Task Manager sabe em qual compasso o trabalho está e dá a próxima entrada;
- o Planner escreve a sequência operacional;
- o Omni autoriza a execução dessa sequência;
- o futuro executor toca a ação;
- o verificador confere se a música terminou como deveria.

O maestro não toca todos os instrumentos. Se fizer isso, coordenação, execução e avaliação se misturam
e ninguém mais sabe quem errou a nota.

## A fronteira sagrada

```text
usuário
   |
   v
Omni -------- entende intenção, conversa e administra o crachá pessoal
   |
   v
Task Manager  administra a vida da tarefa
   |
   v
Overcore      planeja, autoriza por contrato, executa e verifica
   |
   v
TaskResult
```

O Task Manager não:

- interpreta conversa aberta;
- tenta adivinhar uma decisão material do usuário;
- guarda memória pessoal do Omni;
- escolhe antecipadamente agente, skill, modelo ou ferramenta;
- autoriza o próprio plano;
- chama ferramenta diretamente;
- mantém um segundo status escondido fora do `Task State`;
- declara sucesso sem critério e evidência.

## A máquina que ele coordena

```text
TaskDraft
   |
   v
Preflight -------- decisions-required / not-feasible -> volta ao Omni
   |
   v ready
TaskRequest admitido
   |
   v
accepted -> planning -> authorization -> ready -> running -> verifying -> succeeded
              |              |            |         |           |
              +--------------+------------+---------+-----------+--> blocked
              +---------------------------+---------+-----------+--> cancelling -> cancelled
              +-------------------------------------+-----------+--> failed
```

`authorization` é uma fase de coordenação, não um novo estado global. Enquanto o plano aguarda a
decisão do Omni, a tarefa continua em `planning`. Ela só entra em `ready` quando plano e enforcement
são gravados juntos.

## Cada etapa: o que faz e por que existe

### 1. Receber o TaskDraft

**O que faz:** aceita uma intenção estruturada, identifica a revisão e protege sua chave idempotente.

**Por quê:** repetir a mesma entrega de rede não pode criar duas tarefas, e uma mensagem de chat não é
um contrato executável.

### 2. Executar o Preflight

**O que faz:** inspeciona somente o necessário para descobrir antecipadamente contexto ausente,
decisões materiais, autoridade insuficiente, critério impossível ou orçamento inviável.

**Por quê:** decisões previsíveis devem aparecer juntas antes da execução, não em prestações no meio do
trabalho.

Saídas possíveis:

| Situação | Próxima ação do Task Manager |
| --- | --- |
| `decisions-required` | Devolver um único relatório agrupado ao Omni. |
| `not-feasible` | Devolver a inviabilidade sem criar tarefa. |
| `ready` | Persistir e devolver o `preparedRequest` congelado; o cliente admite explicitamente seu `reportId`. |

Quando a compreensão do pedido exigir investigação adicional, o Preflight usa uma porta neutra de
Discovery. A profundidade pode variar de um ajuste pequeno a um sistema amplo. O futuro Agente de
Discovery poderá atender essa porta, mas não conversa no lugar do Omni, não executa a tarefa e não
ganha autoridade de execução.

Na implementação atual, `POST /v1/preflight` recebe somente `{ draft }`. O Preflight Store encontra
os relatórios anteriores, preserva respostas herdadas e exige que decisões pendentes sejam
respondidas na revisão seguinte. O relatório `ready` não é executado silenciosamente: ele contém o
request congelado, e `POST /v1/preflight/{reportId}/admit` recupera esse mesmo documento do Store.
O cliente não reenvia nem edita o request. A antiga admissão HTTP direta foi aposentada; a decisão e
as regras de repetição estão na ADR-010.
`decisions-required` e `not-feasible` persistem o prontuário, mas deixam tarefas e outbox intocadas.

### 3. Admitir o TaskRequest

**O que faz:** valida schema, proveniência, fingerprints e idempotência; persiste o primeiro
`Task State` como `accepted`.

**Por quê:** somente uma tarefa pronta pode consumir recursos de execução. Rascunho incompleto nunca
vira estado operacional.

### 4. Entrar em planning

**O que faz:** cria por CAS a transição `accepted -> planning` e solicita ao Planner uma sequência
linear limitada.

**Por quê:** planejar precisa ocorrer sobre uma revisão conhecida do estado. Dois planners não podem
ativar estratégias concorrentes silenciosamente.

### 5. Preparar o Execution Plan

**O que faz:** recebe um plano que cobre recursos, ações, efeitos, checkpoints, critérios e entrega.

**Por quê:** o caminho precisa existir antes de o sistema pedir permissão ou começar a alterar o mundo.
O Task Manager não escreve comandos opacos nem escolhe executor concreto nesta fase.

### 6. Consultar o Omni

**O que faz:** monta um único `AuthorizationRequest` com todas as ações, espera a
`AuthorizationDecision` e persiste o `Authorization Enforcement`.

**Por quê:** o Overcore não pode ser solicitante, juiz e executor da própria permissão. A decisão é do
Omni, usando o crachá que o usuário administra nele.

Se uma ação for negada, o plano inteiro não ativa. O Planner pode criar outra revisão; ela volta ao
Omni e não herda o crachá temporário anterior.

### 7. Ativar o plano

**O que faz:** numa única gravação CAS:

1. acrescenta a revisão em `ledger.planRefs`;
2. grava o mesmo `authorizationBinding` no histórico e no `activePlanBinding`;
3. cria a transição `planning -> ready`;
4. avança `stateRevision`.

**Por quê:** não pode existir intervalo observável em que o plano esteja pronto sem autorização ou em
que a autorização pertença a outro plano.

### 8. Iniciar a tentativa

**O que faz:** recarrega o enforcement por ID e fingerprint, confere validade e inicia uma tentativa
ligada ao plano ativo e ao epoch atual.

**Por quê:** a autorização pode expirar entre planejamento e execução. A referência gravada no estado
não basta sozinha.

### 8.1 Retomar depois de queda

**O que faz:** ao iniciar e durante a operação, procura tarefas em `accepted`, `planning` ou `ready`,
reserva uma lease curta e calcula a próxima transição a partir do `Task State` persistido.

```text
accepted -> recria somente planning
planning -> recompõe o plano determinístico e consulta o Omni
ready    -> relê plano + autorização e cria somente a outbox ausente
```

**Por quê:** idempotência impede criar duas tarefas, mas sozinha não termina uma tarefa que ficou pela
metade. A reconciliação dá progresso sem usar histórico de chat como memória operacional.

A lease de reconciliação não é um segundo status: apenas escolhe temporariamente qual processo pode
escrever. Ela expira em 30 segundos se o processo cair. Cada transição ainda usa CAS e aparece no
ledger normal. A decisão completa está na ADR-011.

Falhas temporárias usam backoff persistente e visível. Uma autorização vencida recebe nova decisão e
novo enforcement para o mesmo plano, registrados por `authorization-refreshed`; ela nunca é
reutilizada. Negação, resposta permanente inválida ou recurso ausente produz `TaskResult blocked`.
`overcore resume <task-id>` encerra o bloco e volta exclusivamente ao `resumeTarget` seguro. A política
completa está na ADR-012.

### 9. Despachar a próxima ação

**O que faz:** identifica somente a próxima ação admitida pelo prefixo do plano e passa pelo gate:

```text
plano/revisão corretos
   + enforcement válido
   + ação permitida
   + controles satisfeitos
   + autorização não expirada
   + revogação atual, quando journaled
   = dispatch admitido
```

**Por quê:** autorizar o começo da tentativa não é licença eterna para qualquer ferramenta. Cada ação
precisa continuar cabendo na decisão original.

O Task Manager entrega a ação à futura porta de execução. Ele não executa a ferramenta.

### 10. Observar e persistir o resultado do passo

**O que faz:** recebe recibo, evidência, artefatos, consumo e estado de efeito; persiste tudo antes de
escolher o próximo movimento.

**Por quê:** depois de uma queda, o sistema precisa saber o que realmente ocorreu. História de conversa
não substitui journal, checkpoint ou recibo.

### 11. Verificar

**O que faz:** ao terminar o prefixo obrigatório, transita para `verifying` e solicita ao Verifier a
avaliação de todos os critérios contra evidência real.

**Por quê:** “o executor disse que terminou” não é definição de sucesso.

### 12. Recuperar, repetir ou bloquear

**O que faz:** escolhe uma destas saídas estruturadas:

- reconciliar efeito `applying` ou `unknown` antes de qualquer trabalho novo;
- retomar de checkpoint seguro;
- voltar a `planning` para estratégia materialmente diferente, dentro do budget;
- bloquear com `inputRequired` quando surgiu impedimento não previsível;
- falhar quando não existe recuperação admissível.

**Por quê:** retry cego repete defeito e pode duplicar efeito. Bloqueio precisa dizer exatamente o que
falta, sem transformar o Overcore em outro chat.

### 13. Cancelar

**O que faz:** avança o epoch, entra em `cancelling`, impede trabalho novo, reconcilia o que estava em
voo, grava `quiesced` e somente depois entra em `cancelled`.

**Por quê:** cancelar não significa fingir que chamadas externas desapareceram.

### 14. Emitir TaskResult

**O que faz:** projeta o desfecho público a partir da revisão persistida, com critérios, evidências,
artefatos, efeitos e consumo.

**Por quê:** resultado é uma prova da execução, não uma narrativa independente do estado.

## Portas do Task Manager

Porta significa responsabilidade contratada; não significa processo ou serviço separado agora.

| Porta | Quem responde | O que devolve | Por que não fica embutida |
| --- | --- | --- | --- |
| `Preflight` | Preparador limitado | `TaskReadinessReport` | Descoberta não ganha autoridade de execução. |
| `Preflight Store` | PostgreSQL | Corrente + revisões imutáveis | Preparação não depende da sessão do cliente. |
| `Task State Store` | Persistência atômica | Snapshot/revisão/CAS | Estado não pode depender da memória do modelo. |
| `Planner` | Planejador | `Execution Plan` | Coordenar não é inventar a estratégia durante o efeito. |
| `Authority Provider` | Omni | `AuthorizationDecision` | Overcore não autoriza a si próprio. |
| `Enforcement Store` | Persistência interna | Registro verificável | Referência sem documento não concede permissão. |
| `Dispatcher` | Futuro runtime/Harness | Recibo de ação | Task Manager não chama ferramenta diretamente. |
| `Verifier` | Verificador | Resultado por critério | Execução e avaliação não são a mesma opinião. |
| `Result Emitter` | Projetor público | `TaskResult` | O contrato público não expõe todo o ledger. |
| `Clock` | Fonte confiável | Instante monotônico/UTC | Expiração e causalidade não confiam no relógio do comando. |

## Uma única fonte de verdade

O Task Manager não cria uma tabela própria com `queued/running/done` paralela ao `Task State`.

O Preflight Store não viola essa regra: ele existe antes da admissão e registra o prontuário da
intenção. Depois que o request é admitido, o `Task State` continua sendo a única verdade operacional
da execução.

```text
documentos imutáveis                estado operacional

Draft / Report / Request            Task State
Plan / Decision / Enforcement  -->  revisão + referências exatas
```

Documentos explicam **o que foi contratado e autorizado**. O `Task State` registra **onde a execução
está e o que aconteceu**. O Task Manager apenas decide a próxima operação admissível a partir dessas
fontes.

## Loop de coordenação

```text
1. carregar documentos + Task State
2. validar fingerprints, revisão e epoch
3. reconciliar incerteza antes de trabalho novo
4. calcular uma única próxima ação admissível
5. persistir intenção/transição antes do efeito
6. chamar a porta responsável
7. persistir o resultado observado
8. repetir até bloqueio ou terminal
```

Se nenhuma ação é admissível, a decisão é fail-closed. O Manager não improvisa um novo verbo.

## Casos reproduzíveis

[`../../internos/testes/task-manager-cycle-cases.json`](../../internos/testes/task-manager-cycle-cases.json)
fixa vinte situações do ciclo, incluindo:

- agrupar decisões previsíveis;
- não criar tarefa inviável;
- criar plano antes da autorização;
- esperar o Omni sem ativar parcialmente;
- persistir enforcement antes de `ready`;
- rejeitar expiração;
- reconciliar incerteza antes de novo dispatch;
- não reabrir terminal;
- estabilizar cancelamento antes de encerrá-lo.

## Primeira fatia executável proposta

Sem escolher tecnologia ainda, a menor implementação útil deve:

1. rodar em um único processo;
2. aceitar `TaskDraft v1` por uma porta local;
3. executar Preflight e devolver todas as decisões agrupadas;
4. admitir e persistir `TaskRequest + Task State`;
5. criar um plano sequencial;
6. consultar um adaptador da porta do Omni;
7. ativar plano + enforcement atomicamente;
8. despachar uma tarefa representativa por uma porta controlada;
9. sobreviver a restart sem repetir efeito confirmado;
10. verificar critérios e emitir `TaskResult`.

Um processo único não significa arquitetura acoplada. As portas permanecem explícitas; somente não
viram serviços distribuídos antes de existir necessidade.

## Definition of Done do Task Manager v1

1. Não conversa com o usuário nem interpreta prompt aberto.
2. Não mantém estado paralelo ao `Task State`.
3. Preflight incompleto ou inviável nunca cria tarefa.
4. Toda mutação usa CAS e toda execução usa epoch.
5. Plano só ativa com enforcement válido do Omni na mesma revisão.
6. Tentativa e dispatch repetem o gate de autorização.
7. Uma única próxima ação é calculada por ciclo.
8. Incerteza de efeito precede qualquer trabalho novo.
9. Retry cria estratégia materialmente diferente e respeita budget.
10. Cancelamento estabiliza trabalho em voo antes do terminal.
11. Sucesso exige todos os critérios e evidências.
12. Vinte casos do ciclo passam sem agente, skill, modelo ou ferramenta pré-selecionados.

## Decisões necessárias antes do código executável

Estas escolhas alteram materialmente a implementação e serão discutidas com o proprietário:

- linguagem e runtime do primeiro processo;
- armazenamento local e mecanismo de transação/CAS;
- forma da porta local de entrada;
- transporte inicial até o Authority Provider do Omni;
- primeira tarefa real representativa;
- empacotamento e comando de execução.

Agentes, skills, modelos, Registry, Graph Engine e routing continuam fora desta etapa.
