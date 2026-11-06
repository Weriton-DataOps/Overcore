# ADR-023 — Motor SQLite da casa única v1

## Status

Proposta em 2026-11-05 para a F4 da casa única. Escopo e condições combinados com a sessão do Omni
que coordena a casa; o merge depende do ok do proprietário.

Esta ADR **supera em parte** a [ADR-006](ADR-006-fundacao-executavel-v1.md). O PostgreSQL continua
sendo o motor padrão e o único que aceita vários processos trabalhadores. O SQLite entra como segundo
motor, escolhido por configuração, para o Overcore que vive na casa única: uma máquina, um processo,
um arquivo.

## Problema

A casa única reúne Omni, Oráculo e Overcore numa mesma máquina, cada um com seu próprio arquivo
SQLite (`node:sqlite`) e com verbos comuns de instalar, importar, exportar, atualizar e verificar. O
Overcore foi escrito sobre o `pg` e depende de quatro coisas que o SQLite não oferece na mesma forma:

1. `FOR UPDATE SKIP LOCKED` para a reivindicação concorrente da outbox;
2. `withExecutionFence`, que **mantém uma transação aberta durante `await operation()`**. Enquanto
   ela está aberta, o efeito grava no journal por outra conexão e o cancelamento espera na trava da
   linha da tarefa;
3. `jsonb`, `timestamptz`, `clock_timestamp()`, regex em `CHECK` e gatilho `plpgsql`;
4. o código SQLSTATE `23505`, com o nome da constraint violada.

O molde da casa trabalha com transações síncronas: `BEGIN IMMEDIATE`, sem `await` no meio, e uma
transação que devolve uma Promise é recusada. O item 2 não tem tradução direta. É o centro desta
decisão.

## Decisão

### D1. Dois motores atrás das mesmas portas

`TaskStore`, `PreflightStore` e `EffectJournalStore` não mudam. A seleção do motor fica em
`OVERCORE_DATABASE_ENGINE`:

| valor | exige | padrão |
|---|---|---|
| `postgres` | `OVERCORE_DATABASE_URL` | **sim** |
| `sqlite` | `OVERCORE_SQLITE_PATH` (caminho absoluto) | não |

`sqlite` não tem caminho padrão. O arquivo real da casa (`%LOCALAPPDATA%\omni\casa\overcore.db`)
só é indicado pelo instalador da casa (bloco E do plano). Assim, nenhum teste ou execução esquecida
cai nele por omissão.

### D2. Um processo dono por arquivo

O SQLite admite um escritor por vez. A cerca da D3 só vale dentro de um processo. Por isso, o motor
SQLite exige que um único processo seja dono do arquivo:

- a tabela `_dono` tem uma linha só, com `processo`, `maquina`, `token` e `ate`;
- ao abrir, o processo toma a linha em `BEGIN IMMEDIATE`, se ela estiver vazia ou vencida;
- se a posse de outro processo ainda estiver valendo, a abertura falha com erro explícito;
- o processo renova a posse a cada um terço do TTL e a solta ao encerrar; se a renovação falhar
  porque outro processo assumiu, ele encerra em vez de continuar escrevendo;
- se o processo cair, a posse vence sozinha (TTL de 30 s).

A cerca da D3 confia nessa posse única. Vários trabalhadores continuam sendo caso do PostgreSQL, como
a ADR-006 decidiu.

### D3. A cerca vira mutex por tarefa, mais verificação curta

`withExecutionFence` no SQLite segue o que o `InMemoryTaskStore` já faz e que a suíte já exercita:

1. obtém o **mutex assíncrono da tarefa**, que é o mesmo usado pelo `compareAndSwap`;
2. numa transação `BEGIN IMMEDIATE` curta e síncrona, confere o lease da outbox (`claim_token`,
   `processed_at IS NULL`, `locked_until > agora`), a época de execução e o estado (`running` ou
   `verifying` em `execute`; `cancelling` em `reconcile`); se algo falhar, lança
   `ExecutionInterruptedError`;
3. inclui o `outbox_id` no conjunto `emCerca` do processo;
4. executa `await operation()` **sem nenhuma transação aberta**;
5. no `finally`, tira o id de `emCerca` e libera o mutex.

Equivalências com o PostgreSQL:

| garantia no PostgreSQL | como fica no SQLite |
|---|---|
| CAS de cancelamento espera o efeito terminar (`FOR UPDATE` na tarefa) | o CAS espera o mutex da mesma tarefa |
| outro worker não reivindica a mensagem durante o efeito (`SKIP LOCKED`) | `claimOutbox` exclui os ids que estão em `emCerca` |
| worker vencido é barrado na entrada | verificação curta do passo 2 |
| o efeito grava no journal por outra conexão | igual: o journal não usa o mutex da tarefa |

Há uma diferença a favor do SQLite. No PostgreSQL, `extendOutboxLease` fica bloqueado pela linha da
outbox enquanto o efeito roda, e o batimento cardíaco para. No SQLite, o lease continua sendo renovado.
Também há uma regra que vale para os dois motores: a operação dentro da cerca não pode chamar o
`compareAndSwap` da mesma tarefa. No PostgreSQL isso trava; no SQLite também trava, porque o mutex é
o mesmo. A suíte de contrato fixa essa regra.

### D4. Regra das transações

Cada método público do adaptador SQLite abre, usa e fecha uma conexão (`comBanco`). Todo o trabalho
de escrita cabe numa única transação síncrona `BEGIN IMMEDIATE`. A interface continua assíncrona, mas
**nenhum `await` acontece dentro de uma transação**. Se o trabalho devolver uma Promise, a transação
é desfeita e o erro é lançado, como no molde.

### D5. Tradução do esquema

| PostgreSQL | SQLite |
|---|---|
| `jsonb` | `TEXT` com `JSON.stringify`; o mapper faz o parse na leitura |
| `timestamptz` | `TEXT` ISO UTC de 24 caracteres (`toISOString`); a comparação em texto preserva a ordem do tempo |
| `clock_timestamp()` em DML | hora recebida pelo método; se não houver, `new Date()` |
| `clock_timestamp()` em DEFAULT | `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, no mesmo formato de 24 caracteres |
| `~ '^sha256:[a-f0-9]{64}$'` | `length(x)=71 AND substr(x,1,7)='sha256:' AND substr(x,8) NOT GLOB '*[^0-9a-f]*'` |
| gatilho `plpgsql` append-only | `BEFORE UPDATE`/`BEFORE DELETE` com `RAISE(ABORT, ...)` |
| `ANY($n::text[])` | `IN (?, ?, ...)` montado com placeholders |
| `ON CONFLICT DO NOTHING`, `RETURNING`, `->>` | iguais (SQLite 3.35 ou mais novo) |
| `ALTER ... CONSTRAINT`, `DO $$`, `COMMENT` | não existem: o esquema nasce no estado final |

Os mappers devolvem os mesmos tipos de domínio: `Date` onde o PostgreSQL devolve `Date`, e objeto
onde devolve `jsonb`. Sem isso, a suíte de contrato não passa.

### D6. Erro de unicidade normalizado

O SQLite informa `UNIQUE constraint failed: tabela.coluna[, tabela.coluna]`, sem SQLSTATE nem nome
de constraint. O adaptador converte essa mensagem em `{ tabela, colunas }` e decide por esse par, nunca
pelo texto solto. Na admissão, `task_id`, `request_id` e `idempotency_key` produzem a mesma confirmação
por chave de idempotência que o PostgreSQL faz depois do rollback.

### D7. Migrações próprias

- As migrações ficam em `migrations-sqlite/NNNN_nome.sql`, separadas de `migrations/`, que o
  `migrate()` do PostgreSQL lê por inteiro.
- O controle fica na tabela `_migracoes(versao, nome, sha256, aplicada_em)`, no molde da casa: cada
  migração roda na sua própria transação `BEGIN IMMEDIATE`, e uma migração alterada depois de
  aplicada é recusada.
- O hash é calculado sobre o texto **com CRLF convertido para LF**. O repositório usa
  `autocrlf=true` e não tem `.gitattributes`; sem essa normalização, o mesmo commit geraria hashes
  diferentes em checkouts diferentes. As migrações do PostgreSQL continuam como estão.
- A `0001` cria o esquema no estado equivalente ao das migrações PostgreSQL 001 a 008.
- `migrations-sqlite/EQUIVALENCIA.md` declara, para cada migração de `migrations/`, qual migração
  SQLite a cobre. `test/sqlite-equivalencia.test.ts` falha se alguma ficar sem linha.

### D8. Colunas vivas e `_diario`

A casa exporta e importa por `_diario`, então o Overcore segue o molde:

- **tabelas mutáveis** (tarefas, outbox, correntes de preflight, journal de efeitos): `origem_maquina`,
  `criado_em`, `atualizado_em` e `versao`, mantidas pela aplicação. `versao` sobe a cada mudança da
  linha, inclusive nas mudanças de lease que não mexem em `state_revision`. As duas contagens são
  independentes;
- **tabelas append-only** (eventos, revisões de preflight, planos, autorizações, recibos):
  `origem_maquina` e `criado_em`, com `versao` fixa em 1;
- `_diario` tem gatilhos I/U/D em todas as tabelas, com a chave natural em `linha`. O gatilho de
  update só dispara quando `versao` muda;
- **não há `apagado_em`**: o Overcore não apaga linhas de domínio. O gatilho D existe para que um
  apagamento indevido apareça no diário. A F5 (sincronização da casa) trata uma tabela sem essa
  coluna como "sem lápide". Se um dia o Overcore precisar apagar uma linha de domínio, `apagado_em`
  entra por migração **antes** do primeiro apagamento, nunca depois.

### D9. Capacidades por motor

A sonda PostgreSQL ([ADR-015](ADR-015-sonda-postgresql-controlada-v1.md)) testa o próprio PostgreSQL,
então não existe no motor SQLite. Nesse motor, `localExecutorCapabilities` recebe
`hasPostgresTableProbe: false`, e o catálogo
([ADR-016](ADR-016-catalogo-local-de-capacidades-v1.md)) recusa o despacho com
`ExecutorCapabilityUnavailableError`. Não há caminho alternativo improvisado.

### D10. Prova pela suíte de contrato

Uma única suíte (`test/support/task-store-contract.ts`), parametrizada por um motor que sabe abrir,
reabrir e contar o próprio banco, roda contra:

- `InMemoryTaskStore`, sempre;
- `SqliteTaskStore` e `SqliteEffectJournalStore`, **sempre**, porque o `node:sqlite` vem com o Node
  e os testes usam um arquivo em `mkdtemp`;
- os stores PostgreSQL, no `test:postgres`, cada caso num schema descartável.

O comportamento esperado é o do PostgreSQL. Se a suíte revelar divergências do `InMemoryTaskStore`
(ordenação, `completeOutbox`, `releaseOutbox`), o dublê é corrigido: um dublê que mente esconde
defeito.

## Consequências

- O Overcore consegue morar na casa única sem um servidor PostgreSQL.
- Os testes estáticos que fixam o PostgreSQL continuam válidos, porque leem só `migrations/`. Mudam
  apenas os textos da ADR-006 e de `docs/operacao/postgresql-local.md` que dizem "não existe SQLite":
  eles passam a apontar para esta ADR.
- Cada mudança de esquema passa a ter duas migrações. A suíte de contrato é o que impede os motores de
  se afastarem.
- A migração `009_repository_change_receipts.sql`, do ramo do Marco 3, ficou registrada como dívida.
  Ela foi paga na junção dos ramos (ADR-024 D7): a equivalente é
  `migrations-sqlite/0002_repository_change_receipts.sql`, e o recibo de mudança de repositório é gravado
  em `test/sqlite-recibos.test.ts`.

## Fora desta ADR

- Retirar o PostgreSQL.
- Sincronização entre máquinas.
- O sub-executor da casa (`executor/agente.json` e os cinco verbos) e o encaixe da interface. Esses
  itens ficam no bloco E do plano, sem código neste ciclo, porque dependem do contrato com o Omni.
  Depois que a sessão do Omni aceitou o contrato, viraram a
  [ADR-024](ADR-024-sub-executor-da-casa-unica-v1.md).

## Plano

[docs/planos/2026-11-05-f4-adaptador-sqlite-plano.md](../planos/2026-11-05-f4-adaptador-sqlite-plano.md)
