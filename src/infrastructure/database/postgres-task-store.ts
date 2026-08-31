import { randomUUID } from 'node:crypto'

import type { PoolClient } from 'pg'

import type {
  CasMutation,
  ClaimedMessage,
  JsonObject,
  StoredTask,
  TaskDraft,
  TaskReadinessReport,
  TaskRequest,
  TaskState,
  TaskStatus
} from '../../domain/types.js'
import {
  ConcurrentTaskUpdateError,
  DuplicateTaskError,
  type TaskStore
} from '../../ports/task-store.js'
import {
  ConcurrentPreflightUpdateError,
  DuplicatePreflightIntentError,
  type StoredPreflightRevision
} from '../../ports/preflight-store.js'
import type { PostgresPool } from './postgres.js'

interface TaskRow {
  task_id: string
  request_id: string
  idempotency_key: string
  scope_key: string
  status: TaskStatus
  state_revision: number
  execution_epoch: number
  request_document: TaskRequest
  state_document: TaskState
  result_document: JsonObject | null
  created_at: Date
  updated_at: Date
}

interface OutboxRow {
  outbox_id: string
  task_id: string
  kind: 'execute-inspection'
  payload: JsonObject
  available_at: Date
  attempts: number
  claim_token: string
  locked_until: Date
}

interface PreflightRevisionRow {
  draft_id: string
  revision: number
  idempotency_key: string
  draft_fingerprint: string
  draft_document: TaskDraft
  report_id: string
  report_fingerprint: string
  report_document: TaskReadinessReport
  created_at: Date
}

interface PreflightStreamRow {
  draft_id: string
  idempotency_key: string
  latest_revision: number
}

function mapTask(row: TaskRow): StoredTask {
  const task: StoredTask = {
    taskId: row.task_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    scopeKey: row.scope_key,
    status: row.status,
    stateRevision: row.state_revision,
    executionEpoch: row.execution_epoch,
    request: row.request_document,
    state: row.state_document,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
  if (row.result_document) task.result = row.result_document
  return task
}

function mapPreflight(row: PreflightRevisionRow): StoredPreflightRevision {
  return {
    draftId: row.draft_id,
    revision: row.revision,
    idempotencyKey: row.idempotency_key,
    draftFingerprint: { algorithm: 'sha256-jcs-v1', value: row.draft_fingerprint as `sha256:${string}` },
    draft: row.draft_document,
    reportId: row.report_id,
    reportFingerprint: { algorithm: 'sha256-jcs-v1', value: row.report_fingerprint as `sha256:${string}` },
    report: row.report_document,
    createdAt: row.created_at.toISOString()
  }
}

async function insertEvent(client: PoolClient, taskId: string, revision: number, event: CasMutation['event']) {
  await client.query(
    `INSERT INTO overcore_task_events
      (event_id, task_id, state_revision, kind, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [event.eventId, taskId, revision, event.kind, JSON.stringify(event.payload), event.occurredAt]
  )
}

export class PostgresTaskStore implements TaskStore {
  constructor(private readonly pool: PostgresPool) {}

  async findPreflightRevision(draftId: string, revision: number): Promise<StoredPreflightRevision | null> {
    const result = await this.pool.query<PreflightRevisionRow>(
      'SELECT * FROM overcore_preflight_revisions WHERE draft_id=$1 AND revision=$2',
      [draftId, revision]
    )
    return result.rows[0] ? mapPreflight(result.rows[0]) : null
  }

  async findPreflightReport(reportId: string): Promise<TaskReadinessReport | null> {
    const result = await this.pool.query<{ report_document: TaskReadinessReport }>(
      'SELECT report_document FROM overcore_preflight_revisions WHERE report_id=$1',
      [reportId]
    )
    return result.rows[0]?.report_document ?? null
  }

  async findLatestPreflightByIdempotencyKey(idempotencyKey: string): Promise<StoredPreflightRevision | null> {
    const result = await this.pool.query<PreflightRevisionRow>(
      `SELECT r.*
       FROM overcore_preflight_streams s
       JOIN overcore_preflight_revisions r
         ON r.draft_id=s.draft_id AND r.revision=s.latest_revision
       WHERE s.idempotency_key=$1`,
      [idempotencyKey]
    )
    return result.rows[0] ? mapPreflight(result.rows[0]) : null
  }

  async appendPreflightRevision(
    record: StoredPreflightRevision,
    expectedPreviousRevision: number
  ): Promise<StoredPreflightRevision> {
    if (record.revision !== expectedPreviousRevision + 1) {
      throw new Error('A revisão persistida precisa avançar exatamente uma posição.')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const exact = await client.query<PreflightRevisionRow>(
        'SELECT * FROM overcore_preflight_revisions WHERE draft_id=$1 AND revision=$2',
        [record.draftId, record.revision]
      )
      const exactRow = exact.rows[0]
      if (exactRow) {
        if (exactRow.draft_fingerprint !== record.draftFingerprint.value) {
          throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
        }
        await client.query('COMMIT')
        return mapPreflight(exactRow)
      }

      const byIdempotency = await client.query<{ draft_id: string }>(
        'SELECT draft_id FROM overcore_preflight_streams WHERE idempotency_key=$1 FOR UPDATE',
        [record.idempotencyKey]
      )
      const owner = byIdempotency.rows[0]?.draft_id
      if (owner && owner !== record.draftId) throw new DuplicatePreflightIntentError(owner)

      const streamResult = await client.query<PreflightStreamRow>(
        'SELECT draft_id, idempotency_key, latest_revision FROM overcore_preflight_streams WHERE draft_id=$1 FOR UPDATE',
        [record.draftId]
      )
      const stream = streamResult.rows[0]
      if (stream) {
        if (stream.idempotency_key !== record.idempotencyKey) {
          throw new DuplicatePreflightIntentError(record.draftId)
        }
        if (stream.latest_revision !== expectedPreviousRevision) {
          throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
        }
      } else {
        if (expectedPreviousRevision !== 0) {
          throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
        }
        await client.query(
          `INSERT INTO overcore_preflight_streams
            (draft_id, idempotency_key, latest_revision, latest_report_id, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6)`,
          [
            record.draftId,
            record.idempotencyKey,
            record.revision,
            record.reportId,
            record.report.status,
            record.createdAt
          ]
        )
      }

      const inserted = await client.query<PreflightRevisionRow>(
        `INSERT INTO overcore_preflight_revisions
          (draft_id, revision, idempotency_key, draft_fingerprint, draft_document,
           report_id, report_fingerprint, report_document, status, created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10)
         RETURNING *`,
        [
          record.draftId,
          record.revision,
          record.idempotencyKey,
          record.draftFingerprint.value,
          JSON.stringify(record.draft),
          record.reportId,
          record.reportFingerprint.value,
          JSON.stringify(record.report),
          record.report.status,
          record.createdAt
        ]
      )
      if (stream) {
        const updated = await client.query(
          `UPDATE overcore_preflight_streams
           SET latest_revision=$1, latest_report_id=$2, status=$3, updated_at=$4
           WHERE draft_id=$5 AND latest_revision=$6`,
          [
            record.revision,
            record.reportId,
            record.report.status,
            record.createdAt,
            record.draftId,
            expectedPreviousRevision
          ]
        )
        if (updated.rowCount !== 1) {
          throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
        }
      }
      await client.query('COMMIT')
      const row = inserted.rows[0]
      if (!row) throw new Error('PostgreSQL não devolveu a revisão de Preflight criada.')
      return mapPreflight(row)
    } catch (error) {
      await client.query('ROLLBACK')
      const pgError = error as { code?: string }
      if (pgError.code === '23505') {
        const exact = await this.findPreflightRevision(record.draftId, record.revision)
        if (exact?.draftFingerprint.value === record.draftFingerprint.value) return exact
        const owner = await this.pool.query<{ draft_id: string }>(
          'SELECT draft_id FROM overcore_preflight_streams WHERE idempotency_key=$1',
          [record.idempotencyKey]
        )
        if (owner.rows[0]?.draft_id && owner.rows[0].draft_id !== record.draftId) {
          throw new DuplicatePreflightIntentError(owner.rows[0].draft_id)
        }
        throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
      }
      throw error
    } finally {
      client.release()
    }
  }

  async create(task: StoredTask, event: CasMutation['event']): Promise<StoredTask> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<TaskRow>(
        `INSERT INTO overcore_tasks
          (task_id, request_id, idempotency_key, scope_key, status, state_revision, execution_epoch,
           request_document, state_document, result_document, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12)
         RETURNING *`,
        [
          task.taskId, task.requestId, task.idempotencyKey, task.scopeKey, task.status,
          task.stateRevision, task.executionEpoch, JSON.stringify(task.request), JSON.stringify(task.state),
          task.result ? JSON.stringify(task.result) : null, task.createdAt, task.updatedAt
        ]
      )
      await insertEvent(client, task.taskId, task.stateRevision, event)
      await client.query('COMMIT')
      const row = result.rows[0]
      if (!row) throw new Error('PostgreSQL não devolveu a tarefa criada.')
      return mapTask(row)
    } catch (error) {
      await client.query('ROLLBACK')
      const pgError = error as { code?: string; constraint?: string }
      if (pgError.code === '23505' && pgError.constraint?.includes('idempotency')) {
        const existing = await this.findByIdempotencyKey(task.idempotencyKey)
        if (existing) throw new DuplicateTaskError(existing.taskId)
      }
      throw error
    } finally {
      client.release()
    }
  }

  async findById(taskId: string): Promise<StoredTask | null> {
    const result = await this.pool.query<TaskRow>('SELECT * FROM overcore_tasks WHERE task_id = $1', [taskId])
    return result.rows[0] ? mapTask(result.rows[0]) : null
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredTask | null> {
    const result = await this.pool.query<TaskRow>(
      'SELECT * FROM overcore_tasks WHERE idempotency_key = $1',
      [idempotencyKey]
    )
    return result.rows[0] ? mapTask(result.rows[0]) : null
  }

  async findPlan(taskId: string, planId: string, planRevision: number): Promise<JsonObject | null> {
    const result = await this.pool.query<{ document: JsonObject }>(
      `SELECT document FROM overcore_task_plans
       WHERE task_id=$1 AND plan_id=$2 AND plan_revision=$3`,
      [taskId, planId, planRevision]
    )
    return result.rows[0]?.document ?? null
  }

  async findAuthorization(taskId: string, decisionId: string) {
    const result = await this.pool.query<{
      request_document: JsonObject
      decision_document: JsonObject
      enforcement_document: JsonObject
    }>(
      `SELECT request_document, decision_document, enforcement_document
       FROM overcore_task_authorizations
       WHERE task_id=$1 AND decision_id=$2`,
      [taskId, decisionId]
    )
    const row = result.rows[0]
    return row ? {
      request: row.request_document,
      decision: row.decision_document,
      enforcement: row.enforcement_document
    } : null
  }

  async listReconciliationCandidates(limit: number, now = new Date()): Promise<StoredTask[]> {
    const result = await this.pool.query<TaskRow>(
      `SELECT * FROM overcore_tasks
       WHERE status IN ('accepted', 'planning', 'ready')
         AND (reconciliation_until IS NULL OR reconciliation_until <= $1)
       ORDER BY updated_at, task_id
       LIMIT $2`,
      [now, Math.max(0, limit)]
    )
    return result.rows.map(mapTask)
  }

  async claimReconciliation(
    taskId: string,
    ownerId: string,
    leaseMs: number,
    now = new Date()
  ): Promise<string | null> {
    const claimToken = `${ownerId}:${randomUUID()}`
    const until = new Date(now.getTime() + leaseMs)
    const result = await this.pool.query<{ reconciliation_token: string }>(
      `UPDATE overcore_tasks
       SET reconciliation_owner=$1, reconciliation_token=$2, reconciliation_until=$3
       WHERE task_id=$4
         AND status IN ('accepted', 'planning', 'ready')
         AND (reconciliation_until IS NULL OR reconciliation_until <= $5)
       RETURNING reconciliation_token`,
      [ownerId, claimToken, until, taskId, now]
    )
    return result.rows[0]?.reconciliation_token ?? null
  }

  async releaseReconciliation(taskId: string, claimToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE overcore_tasks
       SET reconciliation_owner=NULL, reconciliation_token=NULL, reconciliation_until=NULL
       WHERE task_id=$1 AND reconciliation_token=$2`,
      [taskId, claimToken]
    )
  }

  async compareAndSwap(mutation: CasMutation): Promise<StoredTask> {
    if (mutation.next.stateRevision !== mutation.expectedRevision + 1) {
      throw new Error('CAS precisa avançar exatamente uma revisão.')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (mutation.completeOutbox) {
        const lease = await client.query(
          `SELECT 1 FROM overcore_task_outbox
           WHERE outbox_id = $1 AND claim_token = $2 AND processed_at IS NULL
           FOR UPDATE`,
          [mutation.completeOutbox.outboxId, mutation.completeOutbox.claimToken]
        )
        if (lease.rowCount !== 1) throw new Error('Lease da outbox não confere no fechamento transacional.')
      }
      const result = await client.query<TaskRow>(
        `UPDATE overcore_tasks
         SET status=$1, state_revision=$2, execution_epoch=$3, state_document=$4::jsonb,
             result_document=$5::jsonb, updated_at=$6,
             reconciliation_owner=CASE WHEN $1 IN ('accepted','planning','ready') THEN reconciliation_owner ELSE NULL END,
             reconciliation_token=CASE WHEN $1 IN ('accepted','planning','ready') THEN reconciliation_token ELSE NULL END,
             reconciliation_until=CASE WHEN $1 IN ('accepted','planning','ready') THEN reconciliation_until ELSE NULL END
         WHERE task_id=$7 AND state_revision=$8
         RETURNING *`,
        [
          mutation.next.status, mutation.next.stateRevision, mutation.next.executionEpoch,
          JSON.stringify(mutation.next.state), mutation.next.result ? JSON.stringify(mutation.next.result) : null,
          mutation.next.updatedAt, mutation.next.taskId, mutation.expectedRevision
        ]
      )
      const row = result.rows[0]
      if (!row) throw new ConcurrentTaskUpdateError(mutation.next.taskId, mutation.expectedRevision)

      if (mutation.plan) {
        const planBinding = mutation.plan.planFingerprint as JsonObject
        await client.query(
          `INSERT INTO overcore_task_plans
            (plan_id, plan_revision, task_id, plan_fingerprint, document, created_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
          [
            mutation.plan.planId, mutation.plan.planRevision, mutation.next.taskId,
            planBinding.value, JSON.stringify(mutation.plan), mutation.plan.createdAt
          ]
        )
      }
      if (mutation.authorization) {
        const { request, decision, enforcement } = mutation.authorization
        const planBinding = request.planBinding as JsonObject
        const limits = decision.limits as JsonObject
        await client.query(
          `INSERT INTO overcore_task_authorizations
            (decision_id, task_id, authorization_request_id, plan_id, plan_revision, expires_at,
             request_document, decision_document, enforcement_document)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
          [
            decision.decisionId, mutation.next.taskId, request.authorizationRequestId,
            planBinding.planId, planBinding.planRevision, limits.expiresAt,
            JSON.stringify(request), JSON.stringify(decision), JSON.stringify(enforcement)
          ]
        )
      }
      await insertEvent(client, mutation.next.taskId, mutation.next.stateRevision, mutation.event)
      if (mutation.outbox) {
        await client.query(
          `INSERT INTO overcore_task_outbox
            (outbox_id, task_id, kind, payload, available_at, attempts)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
          [
            mutation.outbox.outboxId, mutation.outbox.taskId, mutation.outbox.kind,
            JSON.stringify(mutation.outbox.payload), mutation.outbox.availableAt, mutation.outbox.attempts
          ]
        )
      }
      if (mutation.completeOutbox) {
        await client.query(
          `UPDATE overcore_task_outbox
           SET processed_at=clock_timestamp(), claim_token=NULL, worker_id=NULL, locked_until=NULL,
               updated_at=clock_timestamp()
           WHERE outbox_id=$1 AND claim_token=$2`,
          [mutation.completeOutbox.outboxId, mutation.completeOutbox.claimToken]
        )
      }
      await client.query('COMMIT')
      return mapTask(row)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async claimOutbox(workerId: string, leaseMs: number, now = new Date()): Promise<ClaimedMessage | null> {
    const claimToken = `${workerId}:${randomUUID()}`
    const lockedUntil = new Date(now.getTime() + leaseMs)
    const result = await this.pool.query<OutboxRow>(
      `WITH candidate AS (
         SELECT outbox_id
         FROM overcore_task_outbox
         WHERE processed_at IS NULL
           AND available_at <= $1
           AND (locked_until IS NULL OR locked_until <= $1)
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE overcore_task_outbox o
       SET claim_token=$2, worker_id=$3, locked_until=$4, attempts=o.attempts+1,
           updated_at=clock_timestamp()
       FROM candidate c
       WHERE o.outbox_id=c.outbox_id
       RETURNING o.outbox_id, o.task_id, o.kind, o.payload, o.available_at,
                 o.attempts, o.claim_token, o.locked_until`,
      [now.toISOString(), claimToken, workerId, lockedUntil.toISOString()]
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      outboxId: row.outbox_id,
      taskId: row.task_id,
      kind: row.kind,
      payload: row.payload,
      availableAt: row.available_at.toISOString(),
      attempts: row.attempts,
      claimToken: row.claim_token,
      lockedUntil: row.locked_until.toISOString()
    }
  }

  async completeOutbox(outboxId: string, claimToken: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE overcore_task_outbox
       SET processed_at=clock_timestamp(), claim_token=NULL, worker_id=NULL, locked_until=NULL,
           updated_at=clock_timestamp()
       WHERE outbox_id=$1 AND claim_token=$2 AND processed_at IS NULL`,
      [outboxId, claimToken]
    )
    if (result.rowCount !== 1) throw new Error('Lease da outbox não confere.')
  }

  async releaseOutbox(outboxId: string, claimToken: string, errorFingerprint: string, retryAt: Date): Promise<void> {
    const result = await this.pool.query(
      `UPDATE overcore_task_outbox
       SET available_at=$3, claim_token=NULL, worker_id=NULL, locked_until=NULL,
           last_error_fingerprint=$4, updated_at=clock_timestamp()
       WHERE outbox_id=$1 AND claim_token=$2 AND processed_at IS NULL`,
      [outboxId, claimToken, retryAt.toISOString(), errorFingerprint]
    )
    if (result.rowCount !== 1) throw new Error('Lease da outbox não confere.')
  }
}
