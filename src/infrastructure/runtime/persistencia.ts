import { hostname } from 'node:os'
import { join } from 'node:path'

import { HarnessPostgresTableProbeExecutor } from '../../application/postgres-table-probe-executor.js'
import { PostgresTableProbeHarness } from '../../application/postgres-table-probe-harness.js'
import type { EffectAuthorityGuard, EffectJournalStore } from '../../ports/effect-journal-store.js'
import type { PostgresTableProbeExecutor, TaskStore } from '../../ports/task-store.js'
import { createPostgresPool, migrate } from '../database/postgres.js'
import { PostgresEffectJournalStore } from '../database/postgres-effect-journal-store.js'
import { PostgresTaskStore } from '../database/postgres-task-store.js'
import { aplicarMigracoes, situacaoDasMigracoes } from '../database/sqlite/migracoes.js'
import { renovarPosse, soltarPosse, tomarPosse, TTL_POSSE_MS } from '../database/sqlite/posse.js'
import { SqliteEffectJournalStore } from '../database/sqlite/sqlite-effect-journal-store.js'
import { SqliteTaskStore } from '../database/sqlite/sqlite-task-store.js'
import type { DatabaseConfig } from './config.js'

/** O que o serve precisa do motor escolhido, já migrado e pronto para escrever. */
export interface Persistencia {
  motor: DatabaseConfig['engine']
  store: TaskStore
  effectJournal: EffectJournalStore
  /**
   * A sonda de tabela mexe no schema do próprio PostgreSQL; no SQLite ela não existe,
   * e o catálogo de executores fica sem ela (ADR-023).
   */
  sondaPostgres?: (journal: EffectJournalStore, authority: EffectAuthorityGuard) => PostgresTableProbeExecutor
  encerrar(): Promise<void>
}

export interface OpcoesDePersistencia {
  /** Chamado se outro processo assumir o arquivo SQLite: este processo precisa parar de escrever. */
  aoPerderPosse: (error: Error) => void
  /**
   * `aplicar` (padrão do serve legado) migra na subida. `exigir` é o servir da casa do Omni: quem migra
   * é o atualizar, com o Overcore parado, e banco fora do esquema do pacote não sobe.
   */
  migracoes?: 'aplicar' | 'exigir'
}

export async function abrirPersistencia(database: DatabaseConfig, projectRoot: string, opcoes: OpcoesDePersistencia): Promise<Persistencia> {
  if (database.engine === 'postgres') {
    const pool = createPostgresPool(database.url)
    await migrate(pool, projectRoot)
    return {
      motor: 'postgres',
      store: new PostgresTaskStore(pool),
      effectJournal: new PostgresEffectJournalStore(pool),
      sondaPostgres: (journal, authority) => new HarnessPostgresTableProbeExecutor(new PostgresTableProbeHarness(pool, journal, authority)),
      encerrar: () => pool.end()
    }
  }

  const arquivo = database.path
  const maquina = hostname()
  const pastaMigracoes = join(projectRoot, 'migrations-sqlite')
  if (opcoes.migracoes === 'exigir') {
    const { pendentes, alteradas, desconhecidas } = situacaoDasMigracoes(arquivo, pastaMigracoes)
    if (pendentes.length) throw new Error(`Migração pendente no banco SQLite (${pendentes.join(', ')}): rode atualizar antes de servir.`)
    if (alteradas.length || desconhecidas.length) {
      throw new Error(`O banco SQLite diverge das migrações do pacote (${[...alteradas, ...desconhecidas].join(', ')}).`)
    }
  } else {
    aplicarMigracoes(arquivo, pastaMigracoes)
  }
  // A cerca por tarefa só vale dentro de um processo (ADR-023 D3); a posse garante que só existe um.
  const posse = tomarPosse(arquivo, { processo: String(process.pid), maquina })
  const renovacao = setInterval(() => {
    try {
      renovarPosse(arquivo, posse.token)
    } catch (error) {
      clearInterval(renovacao)
      opcoes.aoPerderPosse(error instanceof Error ? error : new Error(String(error)))
    }
  }, Math.floor(TTL_POSSE_MS / 3))
  renovacao.unref()
  return {
    motor: 'sqlite',
    store: new SqliteTaskStore(arquivo, maquina),
    effectJournal: new SqliteEffectJournalStore(arquivo, maquina),
    async encerrar() {
      clearInterval(renovacao)
      soltarPosse(arquivo, posse.token)
    }
  }
}
