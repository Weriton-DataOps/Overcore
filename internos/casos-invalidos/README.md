# Casos inválidos do Task State v1

Estes documentos são JSON legível, mas o schema deve rejeitá-los:

- `task-state-running-sem-tentativa.json`: `running` sem `activeAttemptId`;
- `task-state-blocked-sem-identidade.json`: `blocked` sem `blockId`, resultado e destino de retomada;
- `task-state-cancelled-sem-quiescencia.json`: declara término enquanto o cancelamento ainda está
  apenas solicitado.

Regras que dependem de comparar revisões ou percorrer o histórico estão nos vetores de domínio em
[`../testes/task-state-domain-mutations.json`](../testes/task-state-domain-mutations.json).
