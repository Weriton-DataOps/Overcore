# Equivalência entre as migrações PostgreSQL e SQLite

O SQLite não repete o histórico do PostgreSQL. Ele nasce no estado final equivalente (ADR-023 D7):
o que importa é o mesmo comportamento nas portas, não a mesma sintaxe. A suíte de contrato
(`test/support/task-store-contract.ts`) prova o comportamento nos dois motores.

Esta tabela é lida por `test/sqlite-equivalencia.test.ts`. Uma migração nova em `migrations/` sem
linha aqui quebra `npm test`. Se a mudança ainda não tiver equivalente, a migração SQLite nova
(`0002_*.sql`, `0003_*.sql`…) entra no mesmo commit.

| PostgreSQL | SQLite | Como ficou |
|---|---|---|
| `001_task_runtime.sql` | `0001_overcore.sql` | tarefas, eventos, planos, autorizações e outbox; `jsonb` vira texto JSON e `timestamptz` vira texto ISO UTC de 24 caracteres com `CHECK` de formato |
| `002_preflight_runtime.sql` | `0001_overcore.sql` | streams e revisões de preflight; o gatilho `plpgsql` que proíbe alterar revisão vira gatilho SQLite com `RAISE(ABORT)` |
| `003_task_reconciliation_lease.sql` | `0001_overcore.sql` | colunas do lease da reconciliação já nascem em `overcore_tasks`, com o mesmo índice |
| `004_reconciliation_backoff.sql` | `0001_overcore.sql` | colunas de falha e retry da reconciliação já nascem em `overcore_tasks`, com o mesmo índice |
| `005_execution_receipts.sql` | `0001_overcore.sql` | recibos de execução; `clock_timestamp()` vira a hora passada pelo store |
| `006_effect_journal.sql` | `0001_overcore.sql` | journal de efeitos com os mesmos estados e índices |
| `007_file_replacement_receipts.sql` | `0001_overcore.sql` | o `CHECK` do tipo de recibo já aceita `file-replacement-completed` |
| `008_postgres_table_probe_effect.sql` | `0001_overcore.sql` | o `CHECK` aceita `database.schema.modify` e `postgres-table-probe-completed`; o motor SQLite não oferece a sonda (ADR-023 D9), mas o esquema aceita o dado importado do PostgreSQL |

## Só no SQLite

- `_dono`: posse do arquivo por um único processo (ADR-023 D2).
- `_diario` e as colunas `origem_maquina`, `criado_em`, `atualizado_em` e `versao`: registro físico
  das escritas para os verbos da casa (ADR-023 D8).
- `_migracoes`: controle das migrações SQLite aplicadas.
