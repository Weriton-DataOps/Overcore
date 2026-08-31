# Modelos internos do OverCore

Esta pasta contém estados persistidos e versionados usados dentro do OverCore. Eles não são uma porta
de entrada para clientes e não ampliam os contratos públicos de [`../contratos/`](../contratos/).

## Modelo inicial

- [`task-state.schema.json`](task-state.schema.json): snapshot persistente de uma tarefa já admitida;
- [`execution-plan.schema.json`](execution-plan.schema.json): estratégia interna linear criada em
  `planning` e ativada antes de `ready`;
- [`authorization-enforcement.schema.json`](authorization-enforcement.schema.json): projeção interna
  que comprova a ligação entre request, plano, decisão do Omni e elegibilidade de ativação;
- [`autorizacao/exemplos/`](autorizacao/exemplos/): registros válidos de enforcement, separados das
  fotografias do Task State;
- [`testes/task-manager-cycle-cases.json`](testes/task-manager-cycle-cases.json): vinte decisões do
  ciclo de coordenação, do Preflight ao terminal, sem estado paralelo;
- [`planos/exemplos/`](planos/exemplos/): planos válidos de leitura, mutação e retry;
- [`exemplos/`](exemplos/): fotografias válidas de diferentes momentos do ciclo de vida;
- [`casos-invalidos/`](casos-invalidos/): documentos que devem ser rejeitados estruturalmente;
- [`testes/task-state-domain-mutations.json`](testes/task-state-domain-mutations.json): mutações que
  provam invariantes impossíveis de expressar apenas com JSON Schema.

A explicação técnica e didática está em
[`../docs/internos/task-state-v1.md`](../docs/internos/task-state-v1.md).
O plano e seus vínculos estão em
[`../docs/internos/execution-plan-v1.md`](../docs/internos/execution-plan-v1.md).
A fronteira de autorização e sua regra de enforcement estão em
[`../docs/contratos/authorization-v1.md`](../docs/contratos/authorization-v1.md).
O gerente que coordena essas peças está definido em
[`../docs/internos/task-manager-v1.md`](../docs/internos/task-manager-v1.md).

## Fronteira

O cliente envia `TaskDraft` e recebe `TaskReadinessReport` ou `TaskResult`. Ele nunca envia um
`Task State`. O estado nasce somente depois que um `TaskRequest` pronto é validado e admitido.

```text
contratos públicos                 modelo interno

TaskRequest válido  ----------->  Task State persistente
                                       |
                                       +--> plano candidato
                                       +--> enforcement da decisão do Omni
                                       +--> planos ativados
                                       +--> tentativas
                                       +--> step runs
                                       +--> efeitos lógicos + origens de execução
                                       +--> checkpoints
                                       +--> transições
                                       |
TaskResult          <-----------       `--> projeção verificável
```

Uma ativação de plano grava no mesmo CAS o `authorizationBinding` que aponta para o enforcement
validado. O gate de tentativa e de dispatch recarrega esse registro por ID + fingerprint; não confia
somente no campo declarado no snapshot.

O formato físico da persistência, a linguagem e o SDK continuam deliberadamente em aberto.
