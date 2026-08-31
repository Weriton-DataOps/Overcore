# Contratos do OverCore

Esta pasta contém somente contratos públicos e versionados. Eles definem a fronteira; não escolhem
transporte, linguagem, banco de dados, SDK ou provedor de modelo.

O estado persistente da execução é interno e, por isso, vive fora desta pasta em
[`../internos/`](../internos/).

## Contratos iniciais

- `TaskDraft v1`: intenção preliminar e revisável enviada ao Preflight;
- `TaskReadinessReport v1`: checks, decisões agrupadas e pedido preparado;
- `TaskRequest v1`: tarefa pronta produzida pelo Preflight e admitida para execução;
- `TaskResult v1`: resultado verificável ou bloqueio estruturado devolvido ao cliente;
- `AuthorizationRequest v1`: plano exato que o Overcore apresenta ao provedor de autoridade;
- `AuthorizationDecision v1`: decisão mínima e temporária emitida pelo Omni para esse plano.

Documentação detalhada dos contratos:

- [`../docs/contratos/task-request-v1.md`](../docs/contratos/task-request-v1.md);
- [`../docs/contratos/task-result-v1.md`](../docs/contratos/task-result-v1.md);
- [`../docs/contratos/task-preflight-v1.md`](../docs/contratos/task-preflight-v1.md);
- [`../docs/contratos/authorization-v1.md`](../docs/contratos/authorization-v1.md);
- exemplos aceitos em [`exemplos/`](exemplos/);
- exemplos deliberadamente rejeitados em [`casos-invalidos/`](casos-invalidos/);
- mutações adversariais reproduzíveis em [`testes/`](testes/).

## Regras

1. O Omni será o primeiro cliente, mas não faz parte do contrato interno do OverCore.
2. Dados pessoais não entram implicitamente. Todo contexto deve ser explícito e ter proveniência.
3. `requestId` identifica a solicitação; `correlationId` agrupa fluxos relacionados; `idempotencyKey`
   impede repetição de efeitos.
4. `acceptanceCriteria` define conclusão verificável; `objective` sozinho não define sucesso.
5. `TaskRequest.authority` é o teto; a autoridade efetiva nunca pode exceder a interseção entre esse
   teto, as ações exatas do plano e a decisão do Omni.
6. Todo `TaskRequest` conserva a proveniência do draft e do relatório que o prepararam.
7. Orçamento de execução possui fonte explícita e não pode ser ampliado durante a preparação.
8. Resultado contém evidências e decisões estruturadas, nunca raciocínio interno do modelo.
9. Alteração incompatível cria uma nova versão do contrato.
10. O Overcore nunca autoriza a si próprio: consulta a porta `Authority Provider`, ocupada inicialmente
    pelo Omni, e apenas valida e aplica a decisão recebida.
11. Nova revisão do plano exige nova decisão; uma ação negada impede a ativação do plano inteiro.
