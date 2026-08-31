# Exemplos do Task State v1

Cada arquivo é uma fotografia persistida, não uma sequência executável:

- `task-state-accepted.json`: tarefa admitida, ainda sem tentativa;
- `task-state-planning.json`: tarefa admitida em planejamento, ainda sem plano ativo ou autorização;
- `task-state-ready.json`: plano ativado por CAS, pronto para iniciar a primeira tentativa;
- `task-state-running.json`: tentativa ativa com checkpoint pré-mudança e intenção de efeito reservada
  antes da escrita, incluindo a primeira origem de execução do efeito;
- `task-state-change-retry-running.json`: primeira origem mutável comprovada como `not-applied` em
  `attempt 1 / plan r1` e segunda origem reservada em `attempt 2 / plan r2`, no mesmo efeito lógico;
- `task-state-retry-running.json`: primeira estratégia encerrada e segunda tentativa ativa com
  fingerprint diferente, num cenário estritamente de leitura;
- `task-state-failed.json`: as duas estratégias falharam, o orçamento terminou e o resultado terminal
  permaneceu ligado à revisão que encerrou a tarefa;
- `task-state-blocked.json`: bloqueio de planejamento com identidade própria e resultado emitido;
- `task-state-cancelling.json`: pedido de cancelamento já persistido e epoch antigo invalidado;
- `task-state-cancelling-active.json`: cancelamento venceu a corrida enquanto tentativa e efeito do
  epoch antigo ainda aguardam parada cooperativa;
- `task-state-cancelling-quiesced.json`: não há trabalho em voo e a quiescência foi persistida antes
  da transição terminal;
- `task-state-cancelled.json`: cancelamento estabilizado, checkpoint e resultado terminal;
- `task-state-succeeded.json`: bloqueio retomado, efeito confirmado, critérios aprovados e resultado
  terminal ligado à revisão 15.

Os snapshots representam linhas do tempo alternativas para os mesmos requests. Em uma admissão real,
cada request mantém uma única `taskId`; por exemplo, `running` e `succeeded` são revisões da mesma
tarefa, enquanto `cancelling`/`cancelled` mostram a alternativa em que ela foi interrompida.
