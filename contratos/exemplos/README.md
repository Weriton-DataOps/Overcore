# Exemplos dos contratos v1

## Preflight

- `task-draft-incompleto.json`: intenção com decisão de escopo ainda aberta;
- `task-readiness-decisions-required.json`: Preflight reúne a decisão e recomenda uma opção;
- `task-draft-resolvido.json`: nova revisão contendo a resposta e a proveniência do relatório;
- `task-readiness-ready.json`: todos os checks passam, as respostas aplicadas ficam explícitas e nasce
  um `TaskRequest v1` completo com fingerprints verificáveis;
- `task-draft-inviavel.json` e `task-readiness-not-feasible.json`: prazo já expirado torna a intenção
  impossível sem mudar uma constraint material.

## TaskRequest

- `task-request-inspecao.json`: tarefa somente de leitura;
- `task-request-alteracao-controlada.json`: tarefa com alteração limitada a um recurso.

Esses dois arquivos são válidos no JSON Schema e demonstram a forma isolada do `TaskRequest`; os
relatórios citados neles não são fixtures desta pasta. A cadeia de proveniência verificável de ponta a
ponta está no par `task-draft-resolvido.json` + `task-readiness-ready.json`.

## TaskResult

- `task-result-sucesso.json`: todos os critérios passaram;
- `task-result-alteracao-bloqueada.json`: a alteração bloqueou sem efeito, foi conciliada e depois
  antecedeu o resultado de sucesso da mesma tarefa;
- `task-result-bloqueado.json`: falta um recurso e a mesma tarefa pode ser retomada;
- `task-result-falha.json`: o orçamento de recuperação terminou sem validação;
- `task-result-cancelado.json`: o cliente interrompeu e o checkpoint continuou visível.

Os resultados são exemplos estruturais e apresentam destinos possíveis para os pedidos desta pasta;
eles não afirmam que essas execuções aconteceram no ambiente real. Cada resultado contém `stateRef`,
que aponta para a revisão e a transição do modelo interno que geraram a emissão. As cadeias completas
podem ser vistas em [`../../internos/exemplos/`](../../internos/exemplos/); a cadeia de sucesso contém
duas emissões, `blocked` e depois `succeeded`.

## Authorization

- `authorization-request-change-r1.json`: o Overcore apresenta ao Omni todas as ações do plano de
  alteração controlada, com risco e controles explícitos;
- `authorization-decision-change-r1-permit.json`: o Omni autoriza esse plano exato com limites e
  controles adicionais. A decisão não contém o crachá pessoal nem memória do Omni.
