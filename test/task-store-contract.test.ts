import { SqliteEffectJournalStore } from '../src/infrastructure/database/sqlite/sqlite-effect-journal-store.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import { bancoMigrado, contar } from './support/sqlite-fixtures.js'
import { contratoDoTaskStore } from './support/task-store-contract.js'

// O terceiro motor, PostgreSQL, roda a mesma suíte em integration/task-store-contract-postgres.test.ts (npm run test:postgres).

const TABELAS = { eventos: 'overcore_task_events', outbox: 'overcore_task_outbox', streams: 'overcore_preflight_streams' } as const

contratoDoTaskStore({
  nome: 'sqlite',
  async abrir() {
    const arquivo = await bancoMigrado()
    const abrirStores = () => ({ store: new SqliteTaskStore(arquivo, 'maquina-teste'), journal: new SqliteEffectJournalStore(arquivo, 'maquina-teste') })
    return { ...abrirStores(), reabrir: abrirStores, async contar(o_que) { return contar(arquivo, TABELAS[o_que]) } }
  }
})
