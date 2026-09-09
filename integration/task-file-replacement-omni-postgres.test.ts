import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { HarnessFileReplacementExecutor } from '../src/application/file-replacement-executor.js'
import { FileEffectHarness } from '../src/application/file-effect-harness.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { sha256 } from '../src/domain/fingerprint.js'
import type { TaskRequest } from '../src/domain/types.js'
import { HttpAuthorityProvider } from '../src/infrastructure/authority/http-authority-provider.js'
import { HttpEffectAuthorityGuard } from '../src/infrastructure/authority/http-effect-authority-guard.js'
import { FileCheckpointStore } from '../src/infrastructure/checkpoints/file-checkpoint-store.js'
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
  const endpoint = await new Promise<URL>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Omni não iniciou: ${stderr}`)), 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.once('data', (chunk: string) => {
      clearTimeout(timeout)
      try {
        const ready = JSON.parse(chunk.trim()) as { status?: string; url?: string }
        if (ready.status !== 'ready' || typeof ready.url !== 'string') throw new Error('payload ready inválido')
        resolveReady(new URL(ready.url))
      } catch (error) {
        reject(new Error(`Inicialização do Omni inválida: ${String(error)}; ${stderr}`))
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Omni encerrou antes de iniciar (${String(code)}): ${stderr}`))
    })
  })
  return { process: child, endpoint }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
}

function request(targetUri: string, before: string, after: string, suffix: string): TaskRequest {
  const ref = `ref-live-file-${suffix}`
  return {
    contractVersion: '1.0',
    requestId: `request-live-file-${suffix}`,
    idempotencyKey: `execution-live-file-${suffix}`,
    createdAt: new Date().toISOString(),
    preflight: {
      draftId: `draft-live-file-${suffix}`,
      draftRevision: 1,
      draftFingerprint: { algorithm: 'sha256-jcs-v1', value: sha256(`draft-${suffix}`) },
      readinessReportId: `readiness-live-file-${suffix}`
    },
    client: { id: 'client-live-overcore', kind: 'automation' },
    objective: 'Executar uma substituição reversível de arquivo temporário com evidência completa.',
    priority: 'normal',
    context: { references: [{ refId: ref, uri: targetUri, kind: 'file', sensitivity: 'internal' }], assumptions: [] },
    constraints: [{ id: `constraint-live-file-${suffix}`, kind: 'quality', description: 'Somente o arquivo temporário declarado pode ser alterado.' }],
    authority: {
      mode: 'proceed-within-scope',
      grants: [{ resourceRef: ref, operations: ['filesystem.read', 'filesystem.modify'] }],
      expansionBoundaries: ['destructive', 'irreversible', 'financial', 'privilege-expansion', 'external-publication', 'secret-access']
    },
    acceptanceCriteria: [{
      id: `criterion-live-file-${suffix}`,
      description: 'O readback confirma o conteúdo novo do arquivo temporário.',
      verification: { method: 'inspection', expected: 'Digest do readback equivale ao conteúdo declarado.' }
    }],
    budget: { maxDurationMs: 300_000, maxAttempts: 2, maxParallelism: 1 },
    expectedOutput: { kind: 'file', mediaType: 'text/plain', destinationRef: ref },
    execution: { kind: 'replace-file-content', resourceRef: ref, desiredContent: after, expectedBeforeDigest: sha256(before) }
  }
}

test('PostgreSQL, Omni real e TaskManager concluem uma alteração reversível', { timeout: 30_000 }, async () => {
  if (process.env.OVERCORE_RUN_OMNI_EFFECT_E2E !== 'I_UNDERSTAND_LOCAL_FILE_MUTATION') {
    throw new Error('Gate não executado: defina OVERCORE_RUN_OMNI_EFFECT_E2E=I_UNDERSTAND_LOCAL_FILE_MUTATION.')
  }
  const databaseUrl = process.env.OVERCORE_TEST_DATABASE_URL
  const omniRepository = process.env.OVERCORE_OMNI_REPOSITORY_PATH
  if (!databaseUrl || !omniRepository) throw new Error('OVERCORE_TEST_DATABASE_URL e OVERCORE_OMNI_REPOSITORY_PATH são obrigatórias.')
  const token = randomBytes(32).toString('hex')
  const omni = await startOmni(omniRepository, token)
  const pool = createPostgresPool(databaseUrl)
  const directory = await mkdtemp(join(tmpdir(), 'overcore-live-file-task-'))
  let taskId: string | undefined
  try {
    await migrate(pool, root)
    const target = join(directory, 'target.txt')
    const before = 'antes\n'
    const after = 'depois\n'
    await writeFile(target, before, 'utf8')
    const validator = await ContractValidator.create(root)
    const store = new PostgresTaskStore(pool)
    const manager = new TaskManager(store, validator, new HttpAuthorityProvider(omni.endpoint, token))
    const revalidation = new URL(omni.endpoint)
    revalidation.pathname = '/v1/authority/revalidate-effect'
    const worker = new TaskWorker(
      `worker-live-file-${process.pid}`,
      store,
      validator,
      new ReadOnlyContractInspectionExecutor(),
      undefined,
      new HarnessFileReplacementExecutor(new FileEffectHarness(
        new PostgresEffectJournalStore(pool),
        new FileCheckpointStore(join(directory, 'checkpoints')),
        new HttpEffectAuthorityGuard(revalidation, token)
      ))
    )
    const scheduled = await manager.submit(request(pathToFileURL(target).href, before, after, randomUUID().replaceAll('-', '')))
    taskId = scheduled.taskId
    assert.equal(scheduled.status, 'running')
    const completed = await worker.runOnce()
    assert.equal(completed?.status, 'succeeded')
    assert.equal(await readFile(target, 'utf8'), after)
    const journal = await pool.query<{ state: string; apply_count: number }>(
      'SELECT state, apply_count FROM overcore_effect_journal WHERE task_id=$1', [taskId]
    )
    assert.deepEqual(journal.rows, [{ state: 'confirmed', apply_count: 1 }])
    const task = await pool.query<{ status: string }>('SELECT status FROM overcore_tasks WHERE task_id=$1', [taskId])
    assert.equal(task.rows[0]?.status, 'succeeded')
  } finally {
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
    await rm(directory, { recursive: true, force: true })
    await stop(omni.process)
  }
})
