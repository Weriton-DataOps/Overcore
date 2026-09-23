import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { HarnessPostgresTableProbeExecutor } from '../src/application/postgres-table-probe-executor.js'
import { PostgresTableProbeHarness } from '../src/application/postgres-table-probe-harness.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { sha256 } from '../src/domain/fingerprint.js'
import type { CasMutation, JsonObject, TaskRequest } from '../src/domain/types.js'
import { PostgresTaskStore } from '../src/infrastructure/database/postgres-task-store.js'
import { PostgresEffectJournalStore } from '../src/infrastructure/database/postgres-effect-journal-store.js'
import { createPostgresPool, migrate } from '../src/infrastructure/database/postgres.js'
import type { EffectJournalTransition } from '../src/ports/effect-journal-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()
function latch() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
class Clock { private time = Date.now(); now() { return new Date(this.time) }; advance(ms: number) { this.time += ms } }

test('cancelamento persistente: locks reais, retomada e reconciliação da sonda PostgreSQL', { timeout: 30_000 }, async (t) => {
  const url = process.env.OVERCORE_TEST_DATABASE_URL
  if (!url) throw new Error('Configure OVERCORE_TEST_DATABASE_URL para o banco overcore_test.')
  const pool = createPostgresPool(url)
  const tasks: string[] = []
  const tables: string[] = []
  try {
    assert.equal((await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name, 'overcore_test')
    await migrate(pool, root)
    const validator: ContractValidator = await ContractValidator.create(root)
    const request = async (probe: boolean): Promise<TaskRequest> => {
      const suffix = randomUUID().replaceAll('-', '')
      const value = JSON.parse(await readFile(join(root, 'contratos/exemplos/task-request-inspecao-executavel.json'), 'utf8')) as TaskRequest
      value.requestId = `req-cancel-pg-${suffix}`
      value.idempotencyKey = `cancel-pg-${suffix}`
      value.context.references[0]!.uri = pathToFileURL(root).href
      if (probe) {
        const tableName = `overcore_controlled_probe_${suffix}`
        tables.push(tableName)
        const resourceRef = value.context.references[0]!.refId
        value.context.references[0]!.uri = 'postgres://local/overcore_test'
        value.context.references[0]!.kind = 'service'
        value.objective = 'Testar cancelamento da sonda PostgreSQL isolada.'
        value.context.summary = 'Uma tabela de teste única, criada e removida na mesma transação.'
        value.constraints = []
        value.authority.grants[0]!.operations = ['database.schema.read', 'database.schema.modify']
        value.acceptanceCriteria = [{ id: 'criterion-cancel-probe-readback', description: 'Tabela ausente ao final.', verification: { method: 'inspection', expected: 'Ausência da tabela de teste.' } }]
        value.expectedOutput = { kind: 'report', mediaType: 'application/json', destinationRef: resourceRef }
        value.execution = { kind: 'postgres-create-drop-table', resourceRef, databaseName: 'overcore_test', tableName }
      }
      return value
    }

    await t.test('cancelamento disputa a mesma trava do efeito; worker antigo perde execução', async () => {
      const store = new PostgresTaskStore(pool)
      const clock = new Clock()
      const manager = new TaskManager(store, validator, new PermittingAuthorityProvider(() => clock.now()), clock)
      const task = await manager.submit(await request(false)); tasks.push(task.taskId)
      const claim = await store.claimOutbox('worker-pg-fence', 30_000, clock.now())
      assert.ok(claim); assert.equal(claim.taskId, task.taskId)
      const entered = latch(); const release = latch()
      const effect = store.withExecutionFence(claim, task.executionEpoch, 'execute', async () => { entered.resolve(); await release.promise }, clock.now())
      await entered.promise
      let cancelled = false
      const cancellation = manager.cancel(task.taskId).then((value) => { cancelled = true; return value })
      try {
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(cancelled, false)
      } finally { release.resolve() }
      await effect
      assert.equal((await cancellation)?.status, 'cancelling')
      await assert.rejects(store.withExecutionFence(claim, task.executionEpoch, 'execute', async () => assert.fail('efeito atrasado'), clock.now()), /interrompida/)
      clock.advance(30_001)
      const worker = new TaskWorker('worker-pg-after-restart', new PostgresTaskStore(pool), validator, new ReadOnlyContractInspectionExecutor(), clock)
      const closed = await worker.runOnce()
      assert.equal(closed?.status, 'cancelled')
      assert.equal((closed?.result?.stateRef as JsonObject).transitionId, closed?.state.lifecycle.lastTransitionId)
    })

    for (const scenario of ['before-write', 'after-commit', 'uncertain-commit'] as const) {
      await t.test(`sonda cancelada em ${scenario} conserva evidências e não repete CREATE/DROP`, async () => {
        class Store extends PostgresTaskStore {
          failed = false
          override async compareAndSwap(mutation: CasMutation) {
            if (scenario === 'after-commit' && !this.failed && mutation.event.kind === 'task-succeeded') {
              this.failed = true; throw new Error('queda simulada antes do resultado')
            }
            return super.compareAndSwap(mutation)
          }
        }
        class Journal extends PostgresEffectJournalStore {
          failed = false
          override async transitionEffect(change: EffectJournalTransition) {
            if (scenario === 'uncertain-commit' && !this.failed && change.nextState === 'confirmed') {
              this.failed = true; throw new Error('queda simulada após COMMIT antes do journal')
            }
            return super.transitionEffect(change)
          }
        }
        const store = new Store(pool)
        const journal = new Journal(pool)
        const clock = new Clock()
        const entered = latch(); const release = latch()
        const authority = { assertActive: async () => {
          if (scenario === 'before-write') { entered.resolve(); await release.promise }
          return { checkedAt: clock.now().toISOString(), evidenceId: 'evidence-pg-cancel-authority', digest: sha256('active') }
        } }
        const probe = new HarnessPostgresTableProbeExecutor(new PostgresTableProbeHarness(pool, journal, authority, () => clock.now()))
        const manager = new TaskManager(store, validator, new PermittingAuthorityProvider(() => clock.now()), clock)
        const task = await manager.submit(await request(true)); tasks.push(task.taskId)
        const worker = new TaskWorker('worker-pg-probe-cancel', store, validator, new ReadOnlyContractInspectionExecutor(), clock, undefined, probe)
        if (scenario === 'before-write') {
          const execution = worker.runOnce()
          await entered.promise
          try { await manager.cancel(task.taskId) } finally { release.resolve() }
          assert.equal((await execution)?.status, 'cancelled')
        } else {
          if (scenario === 'after-commit') await assert.rejects(worker.runOnce(), /queda simulada/)
          else await worker.runOnce()
          await manager.cancel(task.taskId)
          clock.advance(5_001)
          assert.equal((await worker.runOnce())?.status, 'cancelled')
        }
        const closed = await store.findById(task.taskId)
        validator.assert('task-result', closed?.result)
        const expected = scenario === 'before-write' ? 'not-applied' : scenario === 'after-commit' ? 'confirmed' : 'unknown'
        assert.equal((closed?.result?.effects as JsonObject[])[0]?.status, expected)
        const effects = await pool.query<{ apply_count: number; state: string }>('SELECT apply_count,state FROM overcore_effect_journal WHERE task_id=$1', [task.taskId])
        assert.equal(effects.rows[0]?.apply_count, scenario === 'before-write' ? 0 : 1)
        assert.equal(effects.rows[0]?.state, expected)
        const outbox = await pool.query('SELECT 1 FROM overcore_task_outbox WHERE task_id=$1 AND processed_at IS NULL', [task.taskId])
        assert.equal(outbox.rowCount, 0)
      })
    }
    for (const table of tables) {
      assert.equal((await pool.query<{ found: string | null }>('SELECT to_regclass($1) AS found', [`public.${table}`])).rows[0]?.found, null)
    }
  } finally {
    if (tasks.length) {
      for (const table of ['overcore_effect_journal', 'overcore_task_execution_receipts', 'overcore_task_outbox', 'overcore_task_authorizations', 'overcore_task_plans', 'overcore_task_events', 'overcore_tasks']) {
        await pool.query(`DELETE FROM ${table} WHERE task_id = ANY($1::text[])`, [tasks])
      }
    }
    await pool.end()
  }
})
