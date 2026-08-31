# TaskRequest v1

## O que é

`TaskRequest v1` é o contrato público usado para admitir trabalho executável no OverCore. Ele representa
uma tarefa operacional suficientemente estruturada, formada depois do Preflight; não é uma mensagem de
chat, um prompt bruto ou o primeiro rascunho do pedido.

O primeiro adaptador previsto será o Omni, mas o contrato não contém dependência dele. Clientes CLI,
API, automação ou serviço podem produzir o mesmo `TaskDraft`; somente o Preflight do Task Manager
emite um `TaskRequest`. Nenhum adaptador contorna essa admissão.

Antes dele existem `TaskDraft v1` e `TaskReadinessReport v1`, descritos em
[`task-preflight-v1.md`](task-preflight-v1.md). Uma vez aceito, o `TaskRequest` é imutável; nova decisão
material exige nova preparação e novo fingerprint.

## Fluxo

```text
intenção compreendida pelo cliente
        |
        v
TaskDraft v1
        |
        v
Preflight -> TaskReadinessReport ready
        |
        v
TaskRequest v1
        |
        +--> validação estrutural
        +--> validação de referências
        +--> validação de autoridade
        +--> registro idempotente
        |
        v
tarefa aceita ou rejeição estruturada
```

## Campos

| Campo | Obrigatório | Função |
| --- | --- | --- |
| `contractVersion` | sim | Fixa a semântica do envelope em `1.0`. |
| `requestId` | sim | Identifica esta solicitação específica. |
| `idempotencyKey` | sim | Impede que a mesma intenção produza o mesmo efeito duas vezes. |
| `correlationId` | não | Agrupa solicitações relacionadas sem criar dependência entre elas. |
| `createdAt` | sim | Permite expiração, auditoria e ordenação determinística. |
| `preflight` | sim | Liga o request ao draft, à revisão, ao fingerprint e ao relatório que o prepararam. |
| `client` | sim | Identifica o adaptador chamador; não concede autoridade por si só. |
| `objective` | sim | Descreve o estado final desejado, não a conversa que levou até ele. |
| `priority` | sim | Ordena trabalho; nunca expande autoridade. |
| `deadline` | não | Define limite temporal externo quando realmente existir. |
| `context` | sim | Leva resumo mínimo, referências com proveniência e suposições explícitas. |
| `constraints` | sim | Registra limites verificáveis e identificáveis. Pode ser uma lista vazia. |
| `authority` | sim | Define exatamente em quais recursos e operações o OverCore pode agir. |
| `acceptanceCriteria` | sim | Define como saber, com evidência, que a tarefa terminou corretamente. |
| `budget` | sim | Limita duração, tentativas, paralelismo e, quando aplicável, tokens ou custo. |
| `expectedOutput` | sim | Define a forma contratada da entrega. |

## Contexto

`context.references` usa URIs e identificadores locais ao envelope. Segredos não são transportados no
contrato; uma referência restrita aponta para um mecanismo externo de acesso. Uma referência mutável
sem `digest` deve receber fingerprint no momento da aceitação.

`context.assumptions` separa fatos conhecidos de hipóteses. Se uma hipótese necessária estiver errada,
o OverCore pode recuperar o plano ou devolver bloqueio estruturado em vez de completar com base numa
invenção silenciosa.

## Autoridade

O modo v1 é `proceed-within-scope`: o OverCore avança automaticamente dentro das concessões recebidas.
Cada concessão referencia um recurso do contexto e lista operações com nomes estáveis, por exemplo:

```text
filesystem.read
filesystem.modify
process.execute
test.run
git.inspect
```

Não existe operação coringa. Uma prioridade urgente também não altera as concessões.

`expansionBoundaries` identifica mudanças materiais que precisam voltar ao cliente, como novo
privilégio, gasto ou efeito irreversível. Retry, correção e verificação dentro da autoridade existente
seguem automaticamente.

O `TaskRequest` pode restringir a autoridade oferecida no draft, mas nunca acrescentar recurso,
operação, prazo ou privilégio. As barreiras de expansão do draft precisam permanecer presentes.

Essa autoridade é um **teto**, não a aprovação final de um plano que ainda não existe. Depois que o
`Execution Plan` enumera as ações exatas, o Overcore envia um `AuthorizationRequest` ao Omni. A
`AuthorizationDecision` resultante pode manter ou estreitar o teto, nunca ampliá-lo. O fluxo completo
está em [`authorization-v1.md`](authorization-v1.md).

## Critérios de aceitação

Cada critério tem identidade, descrição e verificação. Para uma tarefa terminar como `succeeded`, todos
os critérios precisam estar `passed` e apontar para evidências no futuro `TaskResult`.

O campo `expected` descreve o resultado observável. Ele não contém raciocínio interno do modelo.

## Invariantes além do JSON Schema

Algumas relações precisam ser verificadas pelo validador de domínio:

1. `requestId` é único.
2. A combinação `client.id + idempotencyKey` identifica uma única intenção; payload diferente gera
   conflito, nunca uma segunda execução.
3. IDs de referências, suposições, constraints e critérios são únicos dentro do envelope.
4. Todo `authority.grants[].resourceRef`, `constraints[].sourceRef` e
   `expectedOutput.destinationRef` aponta para um `context.references[].refId` existente.
5. `deadline` e `authority.expiresAt`, quando presentes, são posteriores a `createdAt` na aceitação.
6. `maxParallelism` expressa o teto solicitado; o primeiro runtime poderá aceitar somente `1`.
7. Uma tarefa sem concessões pode apenas produzir cálculo interno, sem efeito sobre recurso externo.
8. `preflight` coincide exatamente com `draftId`, revisão, fingerprint e `reportId` do
   `TaskReadinessReport ready` que contém o pedido.
9. `client` e `correlationId` permanecem iguais aos do draft.
10. Referências e suposições do request são subconjuntos do contexto do draft; a v1 não admite
    expansão silenciosa durante a transformação.
11. Cada par `resourceRef + operation` em `authority` pertence à autoridade de execução disponível no
    draft, e nenhuma `expansionBoundary` recebida pode ser removida.
12. O orçamento final preserva as mesmas métricas e não ultrapassa nenhum limite do
    `TaskDraft.executionBudget`.
13. O fingerprint do request preparado coincide com o registrado no relatório de prontidão.
14. `idempotencyKey` coincide com `TaskDraft.executionIdempotencyKey`; repetir o Preflight não cria
    outra identidade executável.
15. Campos materiais refinados ou acrescentados possuem entrada correspondente em
    `TaskReadinessReport.requestDerivations`.

## O que ficou deliberadamente para depois

- dependências entre tarefas e DAG;
- escolha de agente, skill, modelo, ferramenta ou procedure;
- transporte e autenticação criptográfica do cliente;
- formato interno do Task State;
- transporte e adaptador executável da porta de autoridade do Omni;
- integração com Oracle;
- linguagem e SDK do runtime.

Essas decisões não são lacunas esquecidas: estão fora da responsabilidade do contrato de entrada v1.
