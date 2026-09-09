import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import pg from 'pg'

import { sha256 } from '../../domain/fingerprint.js'

const { Pool } = pg

export type PostgresPool = InstanceType<typeof Pool>

// Serializa somente a evolução do schema. Workers e tarefas continuam concorrentes.
const MIGRATION_ADVISORY_LOCK = 1_330_922_301

export function createPostgresPool(connectionString: string): PostgresPool {
  if (!connectionString) throw new Error('OVERCORE_DATABASE_URL não foi definido.')
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'overcore-task-manager-v1'
  })
}

export async function assertPostgres18(pool: PostgresPool): Promise<void> {
  const result = await pool.query<{ server_version_num: string }>('SHOW server_version_num')
  const version = Number(result.rows[0]?.server_version_num)
  if (!Number.isInteger(version) || version < 180000) {
    throw new Error(`PostgreSQL 18 ou superior é obrigatório; servidor informou ${String(version)}.`)
  }
}

export async function migrate(pool: PostgresPool, projectRoot: string): Promise<void> {
  await assertPostgres18(pool)
  const client = await pool.connect()
  let locked = false
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK])
    locked = true
    await client.query(`
      CREATE TABLE IF NOT EXISTS overcore_schema_migrations (
        name text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `)
    const migrationsRoot = join(projectRoot, 'migrations')
    const names = (await readdir(migrationsRoot)).filter((name) => name.endsWith('.sql')).sort()
    for (const name of names) {
      const sql = await readFile(join(migrationsRoot, name), 'utf8')
      const digest = sha256(sql)
      const existing = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM overcore_schema_migrations WHERE name = $1',
        [name]
      )
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== digest) throw new Error(`Migração aplicada ${name} foi alterada.`)
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO overcore_schema_migrations(name, sha256) VALUES ($1, $2)',
          [name, digest]
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK])
    client.release()
  }
}
