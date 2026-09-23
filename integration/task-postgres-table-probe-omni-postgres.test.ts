import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'

import { HarnessPostgresTableProbeExecutor } from '../src/application/postgres-table-probe-executor.js'
import { PostgresTableProbeHarness } from '../src/application/postgres-table-probe-harness.js'
import { buildPostgresTableProbePlan } from '../src/application/postgres-table-probe-plan.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { fingerprint, sha256 } from '../src/domain/fingerprint.js'
import type { TaskRequest } from '../src/domain/types.js'
import { HttpAuthorityProvider } from '../src/infrastructure/authority/http-authority-provider.js'
import { HttpEffectAuthorityGuard } from '../src/infrastructure/authority/http-effect-authority-guard.js'
import { createPostgresPool, migrate } from '../src/infrastructure/database/postgres.js'
import { PostgresEffectJournalStore } from '../src/infrastructure/database/postgres-effect-journal-store.js'
import { PostgresTaskStore } from '../src/infrastructure/database/postgres-task-store.js'

const root = process.cwd()

async function startOmni(repository: string, token: string): Promise<{ process: ChildProcessWithoutNullStreams, endpoint: URL }> {
  const child = spawn(process.execPath, [join(repository, 'adaptadores', 'overcore-authority-http.mjs')], {
    cwd: repository,
    env: { ...process.env, OMNI_AUTHORITY_PROVIDER_TOKEN: token, OMNI_AUTHORITY_PROVIDER_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const endpoint = await new Promise<URL>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Omni não iniciou: ${stderr}`)), 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.once('data', (chunk: string) => {
      clearTimeout(timeout)
      try {
        const ready = JSON.parse(chunk.trim()) as { status?: string, url?: string }
        if (ready.status !== 'ready' || typeof ready.url !== 'string') throw new Error('payload ready inválido')
        resolve(new URL(ready.url))
      } catch (error) { reject(error) }
    })
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Omni encerrou antes de iniciar (${String(code)}): ${stderr}`)) })
  })
  return { process: child, endpoint }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
}

function request(tableName: string, suffix: string): TaskRequest {
  const ref = `ref-postgres-probe-${suffix}`
  return {
    contractVersion: '1.0', requestId: `request-postgres-probe-${suffix}`, idempotencyKey: `postgres-probe-${suffix}`,
    createdAt: new Date().toISOString(), preflight: { draftId: `draft-postgres-probe-${suffix}`, draftRevision: 1, draftFingerprint: { algorithm: 'sha256-jcs-v1', value: sha256(`draft-${suffix}`) }, readinessReportId: `readiness-postgres-probe-${suffix}` },
    client: { id: 'client-local-overcore', kind: 'automation' },
    objective: 'Criar e apagar uma tabela temporária controlada no banco local de testes.', priority: 'normal',
    context: { references: [{ refId: ref, uri: 'postgres://local/overcore_test', kind: 'service', sensitivity: 'internal' }], assumptions: [] },
    constraints: [{ id: `constraint-postgres-probe-${suffix}`, kind: 'policy', description: 'Somente a tabela temporária de prefixo controlado pode ser criada e apagada.' }],
    authority: { mode: 'proceed-within-scope', grants: [{ resourceRef: ref, operations: ['database.schema.modify', 'database.schema.read'] }], expansionBoundaries: ['destructive', 'irreversible', 'financial', 'privilege-expansion', 'external-publication', 'secret-access'] },
    acceptanceCriteria: [{ id: `criterion-postgres-probe-${suffix}`, description: 'A tabela temporária foi criada e não existe após a conclusão.', verification: { method: 'inspection', expected: 'CREATE e DROP confirmados por readback.' } }],
    budget: { maxDurationMs: 300_000, maxAttempts: 2, maxParallelism: 1 },
    expectedOutput: { kind: 'report', mediaType: 'application/json', destinationRef: ref },
    execution: { kind: 'postgres-create-drop-table', resourceRef: ref, databaseName: 'overcore_test', tableName }
  }
}

test('PostgreSQL, Omni real e TaskManager criam e removem somente a tabela temporária declarada', { timeout: 30_000 }, async () => {
  if (process.env.OVERCORE_RUN_POSTGRES_PROBE_E2E !== 'I_UNDERSTAND_LOCAL_TEST_TABLE') throw new Error('Gate não executado: defina OVERCORE_RUN_POSTGRES_PROBE_E2E=I_UNDERSTAND_LOCAL_TEST_TABLE.')
  const databaseUrl = process.env.OVERCORE_TEST_DATABASE_URL
  const omniRepository = process.env.OVERCORE_OMNI_REPOSITORY_PATH
  if (!databaseUrl || !omniRepository) throw new Error('OVERCORE_TEST_DATABASE_URL e OVERCORE_OMNI_REPOSITORY_PATH são obrigatórias.')
  const token = randomBytes(32).toString('hex')
  const omni = await startOmni(omniRepository, token)
  const pool = createPostgresPool(databaseUrl)
  const suffix = randomUUID().replaceAll('-', '')
  const tableName = `overcore_controlled_probe_${suffix}`
  let taskId: string | undefined
  try {
    await migrate(pool, root)
    const validator = await ContractValidator.create(root)
    const taskRequest = request(tableName, suffix)
    const candidatePlan = buildPostgresTableProbePlan(
      'task-postgres-probe-live-0001', taskRequest, fingerprint(taskRequest), 2, taskRequest.createdAt
    )
    validator.assert('execution-plan', candidatePlan)
    const store = new PostgresTaskStore(pool)
    const manager = new TaskManager(store, validator, new HttpAuthorityProvider(omni.endpoint, token))
    const endpoint = new URL(omni.endpoint)
    endpoint.pathname = '/v1/authority/revalidate-effect'
    const journal = new PostgresEffectJournalStore(pool)
    const worker = new TaskWorker(
      `worker-postgres-probe-${process.pid}`, store, validator, new ReadOnlyContractInspectionExecutor(), undefined, undefined,
      new HarnessPostgresTableProbeExecutor(new PostgresTableProbeHarness(pool, journal, new HttpEffectAuthorityGuard(endpoint, token)))
    )
    const scheduled = await manager.submit(taskRequest)
    taskId = scheduled.taskId
    assert.equal(
      scheduled.status,
      'running',
      `A sonda deve atravessar planejamento e autorização: ${JSON.stringify({ reconciliation: scheduled.reconciliation, state: scheduled.state })}`
    )
    assert.equal((await worker.runOnce())?.status, 'succeeded')
    assert.equal((await pool.query('SELECT to_regclass($1) AS name', [`public.${tableName}`])).rows[0]?.name, null)
    assert.deepEqual((await pool.query<{ state: string, apply_count: number }>('SELECT state, apply_count FROM overcore_effect_journal WHERE task_id=$1', [taskId])).rows, [{ state: 'confirmed', apply_count: 1 }])
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "${tableName}"`)
    if (taskId) {
      await pool.query('DELETE FROM overcore_task_execution_receipts WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_task_outbox WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_task_authorizations WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_task_plans WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_task_events WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_tasks WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_effect_journal WHERE task_id=$1', [taskId])
    }
    await pool.end()
    await stop(omni.process)
  }
})
