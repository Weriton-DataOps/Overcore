# ADR-017 — Cancelamento seguro antes do dispatch v1

## Estado

Aceita e implementada em 2026-09-22.

Ampliada em 2026-09-23 pela [ADR-018](ADR-018-cancelamento-cooperativo-e-reconciliacao-v1.md).
O texto abaixo registra o primeiro corte; `running` e `verifying` agora são atendidos pelo fluxo
cooperativo e pela reconciliação dos executores existentes.

## Decisão

O Overcore aceita um pedido de cancelamento para tarefas que ainda não iniciaram efeito: `accepted`,
`planning`, `ready` e `blocked`.

O cancelamento é persistido em duas transições CAS, nunca por alteração local em memória:

```text
estado elegível
  -> cancellation-requested / cancelling
  -> cancellation-settled / cancelled
  -> TaskResult cancelled
```

Cada transição avança uma única revisão do `Task State`; a primeira também incrementa o
`executionEpoch`, invalidando qualquer executor que tenha lido a revisão anterior. O encerramento gera
`TaskResult v1` com referências de evidência e não cria nova mensagem de outbox.

O endpoint local é `POST /v1/tasks/{taskId}/cancel`; o mesmo fluxo está disponível por
`overcore cancel <task-id>`.

## Limite deliberado

Uma tarefa em `running` ou `verifying` pode já ter um efeito journaled em andamento. Este corte não
finge abortá-lo: devolve erro explícito até existir reconciliação cooperativa do executor e do journal.
Essa é a próxima extensão de cancelamento, não uma propriedade já comprovada pelo cancelamento
pré-dispatch.

## Consequência

O chamador consegue retirar com segurança trabalho ainda não despachado, sem criar uma execução
fantasma. O cancelamento durante efeito continuará visível como pendência técnica, em vez de produzir
uma confirmação falsa.
