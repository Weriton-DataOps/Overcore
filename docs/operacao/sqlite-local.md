# SQLite local do Overcore

O motor SQLite existe para o Overcore da casa única: uma máquina, um processo, um arquivo. A decisão
e os limites estão na [ADR-023](../decisoes/ADR-023-motor-sqlite-da-casa-unica-v1.md). Para vários
processos trabalhadores, o motor continua sendo o PostgreSQL
([postgresql-local.md](postgresql-local.md)).

## Como ligar

| Variável | Valor |
|---|---|
| `OVERCORE_DATABASE_ENGINE` | `sqlite` |
| `OVERCORE_SQLITE_PATH` | caminho **absoluto** do arquivo, por exemplo `C:\caminho\da\casa\overcore.db` |

Não existe caminho implícito: sem `OVERCORE_SQLITE_PATH`, o `serve` recusa a subida. As outras
variáveis do `serve` (`OVERCORE_LOCAL_TOKEN`, Authority Provider, porta) são as mesmas do PostgreSQL.

## O que o `serve` faz ao subir

1. Aplica `migrations-sqlite/` no arquivo. Cada migração roda na sua própria transação, e uma
   migração alterada depois de aplicada é recusada.
2. Toma a posse do arquivo na tabela `_dono`. Se outro processo tiver a posse valendo, a subida falha
   com o processo e a máquina do dono atual.
3. Renova a posse a cada 10 s (um terço do TTL de 30 s). Se outro processo assumir o arquivo, este
   encerra em vez de continuar escrevendo.
4. Monta o catálogo de executores **sem a sonda PostgreSQL**: uma tarefa de sonda é recusada com
   `ExecutorCapabilityUnavailableError`.

## Como desligar

`SIGINT` (Ctrl+C no terminal), `SIGTERM` ou, quando o processo foi iniciado por um supervisor com
canal IPC, o fechamento desse canal. No Windows, o pai não consegue mandar um sinal que o filho trate;
o supervisor da casa desliga o Overcore fechando o canal. Nos três casos o `serve` para o worker,
fecha o HTTP, apaga o descritor de runtime e solta a posse.

Se o processo morrer sem encerrar, a posse vence sozinha em 30 s, e o próximo `serve` assume.

## Diagnóstico

| Sintoma | Causa | O que fazer |
|---|---|---|
| `O banco já tem dono: processo N em MÁQUINA…` | outro `serve` está vivo sobre o mesmo arquivo, ou morreu há menos de 30 s | encerrar o outro; se ele morreu, esperar o prazo indicado |
| `A posse do banco foi perdida para outro processo` | outro processo assumiu depois de este ficar mais de 30 s sem renovar | este processo já encerrou; conferir quem está com o arquivo |
| `Migração N (nome) mudou depois de aplicada` | um arquivo de `migrations-sqlite/` mudou depois de aplicado | migração aplicada não muda: a correção entra numa migração nova |
| `Nenhum executor declarado cobre execute-postgres-table-probe` | tarefa de sonda no motor SQLite | esperado: a sonda só existe no motor PostgreSQL |

## Como os dois motores ficam iguais

- `test/support/task-store-contract.ts` roda as mesmas 24 verificações no in-memory e no SQLite em
  `npm test`, e no PostgreSQL em `npm run test:postgres`.
- `migrations-sqlite/EQUIVALENCIA.md` diz qual migração SQLite cobre cada migração PostgreSQL;
  `npm test` falha se uma migração nova de `migrations/` ficar sem linha ali.
