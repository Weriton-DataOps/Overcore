# ADR-014 — Harness de efeitos v1

## Status

Aceita e implementada em 2026-09-09 para a primeira mutação controlada de arquivo UTF-8.

## Problema

Uma leitura pode ser repetida depois de uma queda. Uma escrita não. Se o processo cair depois de
alterar o arquivo e antes de atualizar o Task State, uma reentrega cega pode aplicar a mudança duas
vezes. Também pode haver outra pessoa ou ferramenta alterando o mesmo arquivo durante a recuperação.

## Decisão

Toda ferramenta mutável passa por um Harness antes de tocar o recurso. O Harness exige:

1. `effectKey` estável para a intenção lógica;
2. fingerprint da intenção, sem depender da tentativa ou revisão do plano;
3. checkpoint físico anterior à reserva do efeito;
4. journal durável no PostgreSQL;
5. revalidação da autoridade imediatamente antes da escrita;
6. gravação atômica em arquivo temporário seguida de substituição;
7. leitura posterior e confirmação por SHA-256;
8. reconciliação do estado real antes de qualquer retry.

```text
arquivo atual
    |
    v
checkpoint fora do Git
    |
    v
journal: reserved
    |
    v
Omni/guardião revalida a autorização
    |
    v
journal: applying -> escrita atômica -> leitura posterior
                                  |
                 +----------------+----------------+
                 |                                 |
           hash desejado                     outro hash
                 |                                 |
          confirmed                         unknown
```

## Regra de recuperação

Ao retomar um registro `applying` ou `unknown`, o Harness lê o arquivo:

- hash final esperado: confirma sem escrever novamente;
- hash original do checkpoint: marca `not-applied`, revalida a autoridade e tenta uma nova escrita;
- terceiro hash: marca `unknown` e preserva o arquivo encontrado.

O terceiro caso não é uma trava genérica. É prova de alteração concorrente ou parcial. Sobrescrevê-la
automaticamente poderia apagar trabalho legítimo. O registro continua explícito para futura
compensação ou nova decisão, mas o retry cego é proibido.

## Checkpoint e privacidade

O conteúdo anterior não entra no Git nem no PostgreSQL. Ele fica no `CheckpointStore` operacional; o
banco recebe apenas URI interna e hashes. O adaptador atual usa arquivo local e valida que a leitura
permanece dentro do diretório de checkpoints configurado.

## Transação e concorrência

A migration `006_effect_journal.sql` cria uma linha única por `effectKey`. Cada mudança de estado usa
revisão CAS. Duas instâncias podem observar a intenção, mas somente uma consegue mover a mesma revisão
para `applying`.

O migrador também passou a usar um advisory lock do PostgreSQL. Isso impede duas instâncias de criar o
mesmo objeto de schema ao mesmo tempo sem reduzir a concorrência normal dos workers.

## Limite da entrega

O núcleo do Harness, o adaptador PostgreSQL, o armazenamento de checkpoints e a projeção para
`TaskResult` estão implementados. O dispatch mutável do Task Manager também está ligado para uma única
intenção explícita: `replace-file-content` em arquivo UTF-8 declarado no `TaskRequest`.

A cadeia passa por plano, autorização, outbox, revalidação HTTP real do Omni, Harness, Task State e
TaskResult. A prova de integração usa PostgreSQL e Omni reais, mas altera apenas um arquivo temporário
criado pelo próprio teste. Tipos adicionais de efeito continuam fora desta ADR e exigirão contrato,
controle e prova próprios.

## Provas

- repetição idempotente não reescreve efeito confirmado;
- queda antes da escrita retoma a partir de `not-applied` e revalida a autoridade;
- queda depois da escrita confirma por leitura sem duplicar;
- conteúdo concorrente vira `unknown` e não é sobrescrito;
- a mesma `effectKey` não aceita outra intenção;
- ausência de qualquer um dos quatro controles impede a reserva;
- uma nova instância recupera o journal no PostgreSQL;
- duas migrations concorrentes são serializadas.
