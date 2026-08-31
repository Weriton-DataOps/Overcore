import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { beginVerification } from '../src/application/state-builder.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { fingerprint } from '../src/domain/fingerprint.js'
import type { JsonObject, StoredTask, TaskDraft, TaskReadinessReport, TaskRequest, TaskState } from '../src/domain/types.js'
import { createPostgresPool, migrate } from '../src/infrastructure/database/postgres.js'
import { PostgresTaskStore } from '../src/infrastructure/database/postgres-task-store.js'
import { ConcurrentPreflightUpdateError } from '../src/ports/preflight-store.js'
import { ConcurrentTaskUpdateError } from '../src/ports/task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()

function withState(previous: StoredTask, state: TaskState): StoredTask {
  return {
    ...previous,
    status: state.lifecycle.state,
    stateRevision: state.stateRevision,
    executionEpoch: state.executionEpoch,
    state,
    updatedAt: state.updatedAt
  }
}

test('PostgreSQL real persiste, rejeita CAS obsoleto e distribui duas tarefas entre workers', async () => {
  const connectionString = process.env.OVERCORE_TEST_DATABASE_URL
  if (!connectionString) {
    throw new Error('Gate não executado: defina OVERCORE_TEST_DATABASE_URL para um PostgreSQL 18 de teste.')
  }
  const pool = createPostgresPool(connectionString)
  const taskIds: string[] = []
  let preflightDraftId: string | undefined
  try {
    await migrate(pool, root)
    const validator: ContractValidator = await ContractValidator.create(root)
    const store = new PostgresTaskStore(pool)
    const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())

    const draft = JSON.parse(
      await readFile(join(root, 'contratos', 'exemplos', 'task-draft-incompleto.json'), 'utf8')
    ) as TaskDraft
    const preflightSuffix = randomUUID().replaceAll('-', '')
    const now = new Date()
    draft.draftId = `draft-postgres-${preflightSuffix}`
    draft.idempotencyKey = `prepare-postgres-${preflightSuffix}`
    draft.executionIdempotencyKey = `execute-postgres-${preflightSuffix}`
    draft.correlationId = `corr-postgres-${preflightSuffix}`
    draft.createdAt = now.toISOString()
    draft.availableExecutionAuthority.expiresAt = new Date(now.getTime() + 3_600_000).toISOString()
    draft.discoveryAuthority.expiresAt = new Date(now.getTime() + 3_600_000).toISOString()
    preflightDraftId = draft.draftId

    const firstReport = await manager.prepare(draft)
    assert.equal(firstReport.status, 'decisions-required')
    const repeatedReport = await manager.prepare(structuredClone(draft))
    assert.deepEqual(repeatedReport, firstReport)

    const requiredDecision = firstReport.requiredDecisions[0]
    if (!requiredDecision) throw new Error('Preflight PostgreSQL não devolveu a decisão esperada.')
    const resolvedDraft = structuredClone(draft)
    resolvedDraft.revision = 2
    resolvedDraft.createdAt = new Date(now.getTime() + 1_000).toISOString()
    resolvedDraft.context.summary = 'A suposição foi revisada numa nova instância do Task Manager.'
    resolvedDraft.context.assumptions = []
    resolvedDraft.decisionAnswers = [{
      answerId: `answer-postgres-${preflightSuffix}`,
      decisionId: String(requiredDecision.decisionId),
      sourceReport: {
        reportId: firstReport.reportId,
        draftRevision: firstReport.draftRevision,
        draftFingerprint: firstReport.draftFingerprint,
        reportFingerprint: fingerprint(firstReport)
      },
      selectedOptionId: String(requiredDecision.recommendedOptionId),
      answeredAt: new Date(now.getTime() + 500).toISOString(),
      answeredBy: 'owner-primary-user'
    }]

    const restartedManager = new TaskManager(
      new PostgresTaskStore(pool),
      validator,
      new PermittingAuthorityProvider()
    )
    const readyReport = await restartedManager.prepare(resolvedDraft)
    assert.equal(readyReport.status, 'ready')
    assert.equal(readyReport.appliedDecisionAnswers.length, 1)
    assert.equal(readyReport.preparedRequest?.idempotencyKey, draft.executionIdempotencyKey)

    const left = structuredClone(resolvedDraft)
    left.revision = 3
    left.createdAt = new Date(now.getTime() + 2_000).toISOString()
    left.context.summary = 'Terceira revisão produzida pela sessão A.'
    const right = structuredClone(left)
    right.context.summary = 'Terceira revisão concorrente produzida pela sessão B.'
    const competingPreflights = await Promise.allSettled([
      restartedManager.prepare(left),
      new TaskManager(new PostgresTaskStore(pool), validator, new PermittingAuthorityProvider()).prepare(right)
    ])
    assert.equal(competingPreflights.filter((item) => item.status === 'fulfilled').length, 1)
    const rejectedPreflight = competingPreflights.find((item) => item.status === 'rejected')
    assert.ok(
      rejectedPreflight?.status === 'rejected' &&
      rejectedPreflight.reason instanceof ConcurrentPreflightUpdateError
    )
    const persistedPreflight = await pool.query<{
      revision: number
      draft_document: TaskDraft
      report_document: TaskReadinessReport
    }>(
      `SELECT revision, draft_document, report_document
       FROM overcore_preflight_revisions
       WHERE draft_id=$1
       ORDER BY revision`,
      [draft.draftId]
    )
    assert.deepEqual(persistedPreflight.rows.map((item) => item.revision), [1, 2, 3])
    assert.equal(persistedPreflight.rows[0]?.report_document.reportId, firstReport.reportId)
    await assert.rejects(
      pool.query(
        `UPDATE overcore_preflight_revisions
         SET draft_document=$1::jsonb
         WHERE draft_id=$2 AND revision=1`,
        [JSON.stringify({ altered: true } satisfies JsonObject), draft.draftId]
      ),
      /append-only/
    )

    const fixtureTemplate = JSON.parse(
      await readFile(join(root, 'contratos', 'exemplos', 'task-request-inspecao-executavel.json'), 'utf8')
    ) as TaskRequest
    const request = (ordinal: number): TaskRequest => {
      const fixture = structuredClone(fixtureTemplate)
      const suffix = randomUUID().replaceAll('-', '')
      fixture.requestId = `req-postgres-${ordinal}-${suffix}`
      fixture.idempotencyKey = `postgres-inspection-${ordinal}-${suffix}`
      fixture.context.references[0]!.uri = pathToFileURL(root).href
      return fixture
    }

    const first = await manager.submit(request(1))
    const second = await manager.submit(request(2))
    taskIds.push(first.taskId, second.taskId)

    const verifyingAt = new Date().toISOString()
    const verifyingState = beginVerification(first.state, [], verifyingAt)
    const mutation = (suffix: string) => ({
      expectedRevision: first.stateRevision,
      next: withState(first, verifyingState),
      event: {
        eventId: `event-postgres-cas-${suffix}-${randomUUID()}`,
        kind: 'verification-started',
        occurredAt: verifyingAt,
        payload: { gate: 'postgres-cas' }
      }
    })
    const competingWrites = await Promise.allSettled([
      store.compareAndSwap(mutation('a')),
      store.compareAndSwap(mutation('b'))
    ])
    assert.equal(competingWrites.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = competingWrites.find((result) => result.status === 'rejected')
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ConcurrentTaskUpdateError)

    const workerA = new TaskWorker(
      'worker-postgres-a', store, validator, new ReadOnlyContractInspectionExecutor()
    )
    const workerB = new TaskWorker(
      'worker-postgres-b', store, validator, new ReadOnlyContractInspectionExecutor()
    )
    const completed = await Promise.all([workerA.runOnce(), workerB.runOnce()])
    assert.equal(new Set(completed.map((task) => task?.taskId)).size, 2)
    assert.deepEqual(new Set(completed.map((task) => task?.status)), new Set(['succeeded']))

    for (const taskId of taskIds) {
      const reloaded = await store.findById(taskId)
      assert.equal(reloaded?.stateRevision, 6)
      assert.equal(reloaded?.result?.status, 'succeeded')
    }
    const outbox = await pool.query<{ task_id: string; processed_at: Date | null }>(
      'SELECT task_id, processed_at FROM overcore_task_outbox WHERE task_id = ANY($1::text[])',
      [taskIds]
    )
    assert.equal(outbox.rows.length, 2)
    assert.ok(outbox.rows.every((row) => row.processed_at instanceof Date))
  } finally {
    if (preflightDraftId) {
      await pool.query('DELETE FROM overcore_preflight_streams WHERE draft_id=$1', [preflightDraftId])
    }
    if (taskIds.length > 0) {
      await pool.query('DELETE FROM overcore_task_outbox WHERE task_id = ANY($1::text[])', [taskIds])
      await pool.query('DELETE FROM overcore_task_authorizations WHERE task_id = ANY($1::text[])', [taskIds])
      await pool.query('DELETE FROM overcore_task_plans WHERE task_id = ANY($1::text[])', [taskIds])
      await pool.query('DELETE FROM overcore_task_events WHERE task_id = ANY($1::text[])', [taskIds])
      await pool.query('DELETE FROM overcore_tasks WHERE task_id = ANY($1::text[])', [taskIds])
    }
    await pool.end()
  }
})
