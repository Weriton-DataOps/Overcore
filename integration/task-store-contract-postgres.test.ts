import { randomUUID } from 'node:crypto'
import { after } from 'node:test'

import pg from 'pg'

import { migrate, type PostgresPool } from '../src/infrastructure/database/postgres.js'
import { PostgresEffectJournalStore } from '../src/infrastructure/database/postgres-effect-journal-store.js'
import { PostgresTaskStore } from '../src/infrastructure/database/postgres-task-store.js'
import { contratoDoTaskStore } from '../test/support/task-store-contract.js'

// Mesma suíte do in-memory e do SQLite (test/task-store-contract.test.ts), no PostgreSQL de teste.
// Cada banco do contrato é um schema descartável, para os ids fixos das fixtures não colidirem.

const TABELAS = { eventos: 'overcore_task_events', outbox: 'overcore_task_outbox', streams: 'overcore_preflight_streams' } as const
const abertos: Array<{ pool: PostgresPool; schema: string }> = []

after(async () => {
  for (const { pool, schema } of abertos) {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await pool.end() }
  }
})

contratoDoTaskStore({
  nome: 'postgres',
  async abrir() {
    const connectionString = process.env.OVERCORE_TEST_DATABASE_URL
    if (!connectionString) throw new Error('Gate não executado: defina OVERCORE_TEST_DATABASE_URL para um PostgreSQL 18 de teste.')
    const schema = `contrato_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const pool: PostgresPool = new pg.Pool({ connectionString, max: 10, options: `-c search_path=${schema}`, application_name: 'overcore-contrato' })
    abertos.push({ pool, schema })
    await pool.query(`CREATE SCHEMA ${schema}`)
    await migrate(pool, process.cwd())
    const abrirStores = () => ({ store: new PostgresTaskStore(pool), journal: new PostgresEffectJournalStore(pool) })
    return {
      ...abrirStores(),
      reabrir: abrirStores,
      async contar(o_que) {
        const resultado = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${TABELAS[o_que]}`)
        return Number(resultado.rows[0]?.n)
      }
    }
  }
})
