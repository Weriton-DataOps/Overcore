# ADR-018 — Cancelamento cooperativo e reconciliação v1

## Estado

Implementada em 2026-09-23. Amplia e substitui o limite de execução da ADR-017.

## Comportamento

`POST /v1/tasks/{taskId}/cancel` e `node dist/main.js cancel <task-id>` aceitam cancelamento
também em `running` e `verifying`. A resposta pode trazer `cancelling`: o pedido foi persistido,
mas a execução ainda está encerrando. Consultar a tarefa mostra o andamento e o resultado final.

```text
pedido de cancelamento
  -> CAS: cancelling + novo executionEpoch
  -> executor recebe AbortSignal; novas alterações perdem direito de execução
  -> worker confere o journal e o estado real do recurso
  -> CAS: quiesced, tentativas encerradas e evidências referenciadas
  -> CAS: cancelled + TaskResult + conclusão da mensagem da fila
```

O pedido é idempotente. Se o sucesso já tiver sido persistido, o cancelamento devolve esse resultado.
Uma resposta ou falha tardia não pode converter uma tarefa cancelando em sucesso nem gerar retry.

## Onde cada parte atua

- **Task Manager:** recebe o pedido, troca o epoch por CAS e encerra diretamente tarefas sem execução
  pendente. Recupera cancelamentos pré-dispatch interrompidos entre gravações.
- **Worker:** observa cancelamento a cada 200 ms enquanto o executor trabalha, propaga o sinal até o
  Agent Runtime e mantém o lease. Aguarda o executor encerrar antes de confirmar sua parada.
- **Executores mutáveis:** oferecem reconciliação separada da aplicação; a reconciliação não chama
  novamente `apply`, não cria outro efeito e não pede nova autorização para escrever.
- **Task Store:** fornece um fence transacional por posse da fila, estado e epoch. No PostgreSQL,
  a ordem de locks é outbox e tarefa, igual à conclusão transacional da execução.
- **Harness:** protege reservas, escrita atômica/sonda transacional e journal com esse fence.

Se uma alteração atômica já começou, o cancelamento espera essa seção terminar. O objetivo é concluir
ou reconciliar o efeito em voo, e não abandonar um arquivo ou uma transação pela metade.
Worktrees, novos agentes e novas ferramentas não são introduzidos por esta etapa.

## Evidência e retomada

O resultado cancelado preserva checkpoints e classifica efeitos como `confirmed`, `not-applied`
ou `unknown`. Cancelar não desfaz automaticamente uma alteração já confirmada.

No arquivo, o readback compara o digest atual com os estados anterior e pretendido. Uma mudança
externa ou ausência do arquivo é explicitamente relatada. Na sonda PostgreSQL, ausência da tabela
após uma queda entre COMMIT e confirmação do journal não prova que CREATE/DROP ocorreu: esse caso
permanece `unknown`, sem repetir DDL para fabricar evidência.

Uma nova instância recupera o pedido persistido após a expiração do lease, reconcilia e encerra a
fila. Um executor antigo não consegue iniciar escrita com token ou epoch ultrapassado.
Caso a reconciliação não consiga ler o recurso, a tarefa permanece `cancelling`, com reentrega e
erro registrado na fila; ela não recebe confirmação falsa de parada completa.

## Validação

- `npm test`: cancelamento concorrente/repetido, API autenticada, sinal até o SDK simulado,
  recuperação entre gravações, cancelamento durante revalidação, quedas antes/depois da escrita,
  arquivo divergente, efeito confirmado em `verifying` e executor obsoleto.
- `npm run test:cancellation-postgres`: locks PostgreSQL reais, nova instância depois da expiração
  do lease, sonda interrompida antes de escrever, confirmação após COMMIT e COMMIT sem recibo.

Essas provas usam o SDK simulado e o banco `overcore_test`; não consomem uma resposta paga do Claude.
