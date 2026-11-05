# F4 — Adaptador SQLite: plano

Desenho: [ADR-023](../decisoes/ADR-023-motor-sqlite-da-casa-unica-v1.md). Ramo `feat/f4-adaptador-sqlite`,
saído de `main`. Cada tarefa é feita em TDD: o teste nasce vermelho, o código o deixa verde e só então
vem o commit.

Regras do ciclo:

- teste só em `mkdtemp`; nenhum teste abre `%APPDATA%\omni` nem `%LOCALAPPDATA%\omni\casa`;
- o PostgreSQL continua sendo o padrão, e o caminho dele não muda;
- não se escreve nos repositórios do Omni.

## Bloco A: base (não depende do Omni)

| # | Tarefa | Teste que fica verde |
|---|---|---|
| A0 | Conferir `node:sqlite` no Node do projeto e os tipos em `@types/node`; `engines` coerente | `DatabaseSync` importa e compila no `tsc` estrito |
| A1 | `config.ts`: `OVERCORE_DATABASE_ENGINE` (`postgres` padrão, `sqlite`), `OVERCORE_SQLITE_PATH` absoluto e obrigatório no `sqlite` | sem variável = postgres com URL exigida; `sqlite` sem caminho = erro; caminho relativo = erro; valor desconhecido = erro |
| A2 | `sqlite/banco.ts` reproduzido do molde: `busy_timeout`, WAL com `insistirSeOcupado`, `synchronous=NORMAL`, `foreign_keys=ON`, `comBanco`, `transacao` síncrona com `BEGIN IMMEDIATE` | pragmas lidos de volta; trabalho que devolve Promise faz rollback e lança erro; `comBanco` fecha no erro; aninhamento é recusado |
| A3 | Carregador de `migrations-sqlite/NNNN_*.sql` com `_migracoes` e hash do texto normalizado para LF | aplica em ordem; a segunda abertura não reaplica; SQL alterado é recusado; CRLF e LF dão o mesmo hash; nome fora do padrão é erro |
| A4 | `migrations-sqlite/0001_overcore.sql`: esquema final equivalente ao PG 001–008, colunas vivas, `_diario` com gatilhos, `_dono` | append-only barra UPDATE/DELETE; `CHECK` de `sha256:` barra um valor inválido; o diário grava I/U/D; UPDATE sem mudar `versao` não entra no diário; FK ligada |
| A5 | Posse do arquivo (`_dono`): tomar, renovar, soltar, vencer | um segundo processo filho real é recusado enquanto a posse vale; depois do TTL, assume; soltar libera na hora |

## Bloco B: adaptadores

| # | Tarefa | Teste que fica verde |
|---|---|---|
| B1 | Mappers (`Date`, JSON) e `unicidade(erro) → {tabela, colunas}` | colisão em cada chave única gera o par certo; uma mensagem que não é de unicidade passa intacta |
| B2 | `SqlitePreflightStore`: as quatro operações | `exercisePreflightRoundtrip` verde no SQLite |
| B3 | Admissão, leitura, plano, autorização e `compareAndSwap` do `SqliteTaskStore` | admissão repetida devolve a mesma tarefa por qualquer uma das três chaves; CAS com revisão velha falha; evento e outbox entram na mesma transação |
| B4 | Outbox (`claim`, `extend`, `complete`, `release`) e leases de reconciliação | lease vencido é reivindicado de novo; token errado não fecha nem solta; `retryAt` respeitado; a ordem segue a do PostgreSQL |
| B5 | `withExecutionFence` (ADR-023 D3) | o CAS de cancelamento espera o fim do efeito; `claimOutbox` não pega mensagem em cerca; época, estado ou lease errados geram `ExecutionInterruptedError`; nenhuma transação fica aberta durante `operation` (checado por um `BEGIN IMMEDIATE` paralelo que não espera) |
| B6 | `SqliteEffectJournalStore` | reserva idempotente por `effectKey`; transição só a partir dos estados permitidos |
| B7 | Recibos de execução | `saveExecutionReceipt` repetido é idempotente; token errado é recusado |

## Bloco C: prova e ligação

| # | Tarefa | Teste que fica verde |
|---|---|---|
| C1 | `test/support/task-store-contract.ts`: suíte única parametrizada; B2–B7 migram para ela | verde no in-memory e no SQLite em `npm test`; verde no PostgreSQL em `npm run test:postgres` |
| C2 | Corrigir as divergências do in-memory que a C1 revelar | mesma suíte, mesmo resultado nos três motores |
| C3 | `main.ts serve`: seleção de motor; no `sqlite`, catálogo sem a sonda PostgreSQL | `serve` com `sqlite` em pasta temporária sobe, responde a `/health` e encerra soltando a posse; uma tarefa de sonda é recusada pelo catálogo |
| C4 | Docs: nota na ADR-006, `postgresql-local.md` apontando para a ADR-023, `operacao/sqlite-local.md` | testes estáticos atuais intactos; links resolvem |

## Bloco E: depende do Omni (para antes de cruzar a fronteira)

Neste ciclo, nada aqui vira código.

| # | Tarefa | Quem destrava |
|---|---|---|
| E1 | Contrato `executor/agente.json` do Overcore (`banco`, `migracoes: migrations-sqlite`, `requer`, `interface`, `tarefas`, `credenciais` por nome no broker), proposto à sessão do Omni antes de congelar | aceite do contrato pela sessão do Omni |
| E2 | Sub-executor com os cinco verbos (instalar, importar, exportar, atualizar, verificar) sobre o `overcore.db`; a prova é exportar → instalar limpo → importar → verificar com 100% de contagem e hash | E1 |
| E3 | Interface em `interface/`: cópia literal dos arquivos da ilha mais `interface/ORIGEM.json` com sha256; preload via `agente:api` | E1 + o canal `agente:api` na ilha (Omni) |
| E4 | Corte real: `OVERCORE_SQLITE_PATH` apontando para a casa, com importação dos dados do PostgreSQL atual | casa real criada pela F1 do Omni + ok do proprietário |

## Dívida registrada

- `009_repository_change_receipts.sql` (Marco 3): quando os ramos se juntarem, vira
  `migrations-sqlite/0002_*.sql`, e a C1 passa a cobrir os recibos de mudança de repositório.

## Riscos

1. **Cerca só no processo.** Se dois processos usarem o mesmo arquivo, a D3 deixa de valer.
   Mitigação: posse única (A5), testada com processo filho real.
2. **Hora em texto.** Uma hora fora do formato de 24 caracteres quebra a comparação. Mitigação: toda
   hora passa por `toISOString`; os `CHECK` de comprimento nas colunas de tempo barram o resto.
3. **Motores se afastando com o tempo.** Mitigação: a C1 é obrigatória em `npm test`, e a C4 inclui
   um teste estático que lê `migrations-sqlite/EQUIVALENCIA.md` e falha se alguma migração de
   `migrations/` não tiver uma equivalente declarada.
