# ADR-006 — Fundação executável v1

## Estado

Aceita em 2026-08-31 pelo proprietário, com a correção de que o Overcore trabalhará com muitos
projetos simultaneamente e, portanto, não nascerá apoiado em SQLite.

## Decisão

### Linguagem e runtime

O código-fonte será TypeScript estrito e executará em Node.js 24 LTS. O TypeScript protege as
relações entre tarefa, plano, autorização, estado e resultado antes da execução; os JSON Schemas
continuam sendo a autoridade na fronteira de runtime.

### Banco operacional

O banco será PostgreSQL 18, em instância dedicada ao Overcore. Bancos dos projetos atendidos não são
usados como memória operacional do ambiente. O PostgreSQL foi escolhido porque o Overcore precisa
aceitar tarefas de muitos projetos e permitir vários trabalhadores sem reduzir toda escrita a um
único escritor local.

O primeiro esquema usa:

- `task_id` como identidade da tarefa;
- `scope_key` como índice determinístico dos repositórios/workspaces envolvidos, sem criar Registry;
- `state_revision` para compare-and-swap (CAS);
- documentos canônicos em `jsonb` e colunas relacionais apenas para identidade, concorrência e busca;
- ledger append-only;
- outbox transacional;
- `FOR UPDATE SKIP LOCKED` para trabalhadores concorrentes pegarem itens diferentes.

O CAS executa conceitualmente:

```sql
UPDATE overcore_tasks
SET state_revision = state_revision + 1, state_document = $novo
WHERE task_id = $task AND state_revision = $esperada;
```

Zero linhas atualizadas significa conflito; nunca significa sucesso silencioso.

### Processo e porta local

O Task Manager será um serviço local independente. Ele escuta somente em `127.0.0.1`; `port = 0`
deixa o sistema operacional selecionar uma porta livre. O endereço efetivo é gravado em um descritor
local, permitindo que CLI, Omni e a futura interface descubram o processo sem uma porta fixa sujeita
a colisões.

HTTP transporta JSON. Um token local é exigido. Loopback não significa internet pública: o serviço
não escuta em `0.0.0.0`.

### Comunicação com o Omni

O Overcore depende somente da porta `AuthorityProvider`:

```text
AuthorizationRequest v1 -> Authority Provider -> AuthorizationDecision v1
```

O primeiro adaptador usa HTTP local. Nenhum módulo, memória, personalidade ou crachá do Omni é
importado. O adaptador de teste pode simular uma decisão apenas em testes e demonstrações; o runtime
normal falha fechado se o provedor real estiver ausente ou devolver documento inválido.

### Primeira tarefa executável

A primeira tarefa é uma inspeção somente leitura dos contratos do próprio Overcore. Ela prova
validação, planejamento, autorização, CAS, outbox, execução real de leitura, verificação e
`TaskResult`, sem introduzir uma mutação de repositório antes de o substrato estar comprovado.

## Ferramentas e responsabilidades

| Peça | Responsabilidade | Não faz |
|---|---|---|
| TypeScript | verifica relações do código no desenvolvimento | não substitui JSON Schema |
| Node.js | executa serviço, CLI, trabalhador e adaptadores | não decide autoridade |
| PostgreSQL | persiste estado, ledger, CAS e outbox | não guarda personalidade do Omni |
| `pg` | conecta Node ao PostgreSQL e controla transações | não contém regra de negócio |
| Ajv | valida documentos contra os schemas 2020-12 | não corrige documento inválido |
| HTTP local | comunica processos independentes | não expõe serviço à rede externa |
| CLI | controla o serviço pelo terminal | não cria outro Task Manager |
| Authority Provider | obtém a decisão do Omni | não permite que o Overcore se autorize |
| Executor de inspeção | lê e mede os contratos autorizados | não altera arquivos |
| Verificador | compara evidência com critérios | não aceita sucesso por código de saída apenas |

## Consequências

- PostgreSQL precisa ser instalado ou fornecido antes do gate de integração real.
- O código pode ser testado com portas em memória, mas isso não conta como prova do banco.
- Agentes, skills, Graph Engine e Registry continuam fora desta etapa.
