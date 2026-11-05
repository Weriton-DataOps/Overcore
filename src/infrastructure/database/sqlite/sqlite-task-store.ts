import type { DatabaseSync } from 'node:sqlite'

import type {
  CasMutation,
  ClaimedMessage,
  ExecutionReceipt,
  JsonObject,
  StoredTask,
  TaskRequest,
  TaskState,
  TaskStatus
} from '../../../domain/types.js'
import {
  ConcurrentTaskUpdateError,
  DuplicateTaskError,
  type ReconciliationFailure,
  type StoredTaskAuthorization,
  type TaskStore
} from '../../../ports/task-store.js'
import { instante, lerJson, unicidade } from './mapeamento.js'
import { SqlitePreflightStore } from './sqlite-preflight-store.js'

interface TaskRow {
  task_id: string
  request_id: string
  idempotency_key: string
  scope_key: string
  status: TaskStatus
  state_revision: number
  execution_epoch: number
  request_document: string
  state_document: string
  result_document: string | null
  reconciliation_failure_count: number
  reconciliation_retry_at: string | null
  reconciliation_error_code: string | null
  reconciliation_error_fingerprint: string | null
  reconciliation_last_error_at: string | null
  created_at: string
  updated_at: string
}

const CHAVES_DA_TAREFA = new Set(['task_id', 'request_id', 'idempotency_key'])

/** Atualização das colunas da casa (ADR-023 D8) em toda linha mutável que muda. */
const CASA = "versao = versao + 1, atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

function mapTask(row: TaskRow): StoredTask {
  const task: StoredTask = {
    taskId: row.task_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    scopeKey: row.scope_key,
    status: row.status,
    stateRevision: row.state_revision,
    executionEpoch: row.execution_epoch,
    request: lerJson<TaskRequest>(row.request_document),
    state: lerJson<TaskState>(row.state_document),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (row.result_document !== null) task.result = lerJson<JsonObject>(row.result_document)
  if (
    row.reconciliation_failure_count > 0 &&
    row.reconciliation_retry_at &&
    row.reconciliation_error_code &&
    row.reconciliation_error_fingerprint &&
    row.reconciliation_last_error_at
  ) {
    task.reconciliation = {
      failureCount: row.reconciliation_failure_count,
      retryAt: row.reconciliation_retry_at,
      errorCode: row.reconciliation_error_code,
      errorFingerprint: row.reconciliation_error_fingerprint,
      lastErrorAt: row.reconciliation_last_error_at
    }
  }
  return task
}

function pendente(metodo: string, tarefa: string): never {
  throw new Error(`SqliteTaskStore.${metodo} entra na tarefa ${tarefa} da F4.`)
}

/**
 * TaskStore no SQLite (ADR-023), espelhando o PostgresTaskStore. Cada operação abre a
 * própria conexão e fecha a transação antes de devolver o controle (D4).
 */
export class SqliteTaskStore extends SqlitePreflightStore implements TaskStore {
  async create(task: StoredTask, event: CasMutation['event']): Promise<StoredTask> {
    try {
      return this.escrever((db) => {
        this.inserir(db, 'overcore_tasks', {
          task_id: task.taskId, request_id: task.requestId, idempotency_key: task.idempotencyKey,
          scope_key: task.scopeKey, status: task.status, state_revision: task.stateRevision,
          execution_epoch: task.executionEpoch, request_document: JSON.stringify(task.request),
          state_document: JSON.stringify(task.state), result_document: task.result ? JSON.stringify(task.result) : null,
          created_at: instante(task.createdAt), updated_at: instante(task.updatedAt)
        })
        this.inserirEvento(db, task.taskId, task.stateRevision, event)
        return this.tarefa(db, task.taskId)
      })
    } catch (error) {
      const colisao = unicidade(error)
      if (colisao?.tabela === 'overcore_tasks' && colisao.colunas.length === 1 && CHAVES_DA_TAREFA.has(colisao.colunas[0] ?? '')) {
        // Como no PostgreSQL, qualquer das três chaves pode colidir primeiro; só a mesma chave idempotente é duplicata.
        const existing = await this.findByIdempotencyKey(task.idempotencyKey)
        if (existing) throw new DuplicateTaskError(existing.taskId)
      }
      throw error
    }
  }

  async findById(taskId: string): Promise<StoredTask | null> {
    const row = this.ler((db) => db.prepare('SELECT * FROM overcore_tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined)
    return row ? mapTask(row) : null
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredTask | null> {
    const row = this.ler((db) => db.prepare('SELECT * FROM overcore_tasks WHERE idempotency_key = ?').get(idempotencyKey) as TaskRow | undefined)
    return row ? mapTask(row) : null
  }

  async findPlan(taskId: string, planId: string, planRevision: number): Promise<JsonObject | null> {
    const row = this.ler((db) => db.prepare(`SELECT document FROM overcore_task_plans
      WHERE task_id = ? AND plan_id = ? AND plan_revision = ?`).get(taskId, planId, planRevision) as { document: string } | undefined)
    return row ? lerJson<JsonObject>(row.document) : null
  }

  async findAuthorization(taskId: string, decisionId: string): Promise<StoredTaskAuthorization | null> {
    const row = this.ler((db) => db.prepare(`SELECT request_document, decision_document, enforcement_document
      FROM overcore_task_authorizations WHERE task_id = ? AND decision_id = ?`).get(taskId, decisionId) as
      { request_document: string; decision_document: string; enforcement_document: string } | undefined)
    return row ? {
      request: lerJson<JsonObject>(row.request_document),
      decision: lerJson<JsonObject>(row.decision_document),
      enforcement: lerJson<JsonObject>(row.enforcement_document)
    } : null
  }

  async compareAndSwap(mutation: CasMutation): Promise<StoredTask> {
    if (mutation.next.stateRevision !== mutation.expectedRevision + 1) {
      throw new Error('CAS precisa avançar exatamente uma revisão.')
    }
    return this.escrever((db) => this.aplicarMutacao(db, mutation))
  }

  async listReconciliationCandidates(_limit: number, _now?: Date): Promise<StoredTask[]> { return pendente('listReconciliationCandidates', 'B4') }
  async claimReconciliation(_taskId: string, _ownerId: string, _leaseMs: number, _now?: Date): Promise<string | null> { return pendente('claimReconciliation', 'B4') }
  async deferReconciliation(_taskId: string, _claimToken: string, _failure: ReconciliationFailure): Promise<void> { pendente('deferReconciliation', 'B4') }
  async releaseReconciliation(_taskId: string, _claimToken: string): Promise<void> { pendente('releaseReconciliation', 'B4') }
  async claimOutbox(_workerId: string, _leaseMs: number, _now?: Date): Promise<ClaimedMessage | null> { return pendente('claimOutbox', 'B4') }
  async extendOutboxLease(_outboxId: string, _claimToken: string, _leaseMs: number, _now?: Date): Promise<void> { pendente('extendOutboxLease', 'B4') }
  async completeOutbox(_outboxId: string, _claimToken: string): Promise<void> { pendente('completeOutbox', 'B4') }
  async releaseOutbox(_outboxId: string, _claimToken: string, _errorFingerprint: string, _retryAt: Date): Promise<void> { pendente('releaseOutbox', 'B4') }
  async withExecutionFence<T>(_claim: ClaimedMessage, _epoch: number, _mode: 'execute' | 'reconcile', _operation: () => Promise<T>, _now?: Date): Promise<T> { return pendente('withExecutionFence', 'B5') }
  async findExecutionReceipt(_outboxId: string): Promise<ExecutionReceipt | null> { return pendente('findExecutionReceipt', 'B7') }
  async saveExecutionReceipt(_receipt: ExecutionReceipt, _claimToken: string, _now?: Date): Promise<ExecutionReceipt> { return pendente('saveExecutionReceipt', 'B7') }

  protected tarefa(db: DatabaseSync, taskId: string): StoredTask {
    const row = db.prepare('SELECT * FROM overcore_tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined
    if (!row) throw new Error(`SQLite não devolveu a tarefa ${taskId}.`)
    return mapTask(row)
  }

  private inserirEvento(db: DatabaseSync, taskId: string, revision: number, event: CasMutation['event']): void {
    this.inserir(db, 'overcore_task_events', {
      event_id: event.eventId, task_id: taskId, state_revision: revision, kind: event.kind,
      payload: JSON.stringify(event.payload), occurred_at: instante(event.occurredAt)
    })
  }

  /** Mesma ordem do PostgreSQL: lease da outbox, tarefa, plano, autorização, evento, outbox nova, fechamento. */
  private aplicarMutacao(db: DatabaseSync, mutation: CasMutation): StoredTask {
    const { next } = mutation
    if (mutation.completeOutbox) {
      const lease = db.prepare(`SELECT 1 FROM overcore_task_outbox
        WHERE outbox_id = ? AND claim_token = ? AND processed_at IS NULL`)
        .get(mutation.completeOutbox.outboxId, mutation.completeOutbox.claimToken)
      if (!lease) throw new Error('Lease da outbox não confere no fechamento transacional.')
    }
    const mantem = (coluna: string, zerado = 'NULL') =>
      `${coluna} = CASE WHEN $status IN ('accepted', 'planning', 'ready') THEN ${coluna} ELSE ${zerado} END`
    const updated = db.prepare(`UPDATE overcore_tasks
      SET status = $status, state_revision = $revision, execution_epoch = $epoch, state_document = $state,
          result_document = $result, updated_at = $updatedAt,
          ${mantem('reconciliation_owner')}, ${mantem('reconciliation_token')}, ${mantem('reconciliation_until')},
          ${mantem('reconciliation_failure_count', '0')}, ${mantem('reconciliation_retry_at')},
          ${mantem('reconciliation_error_code')}, ${mantem('reconciliation_error_fingerprint')},
          ${mantem('reconciliation_last_error_at')}, ${CASA}
      WHERE task_id = $taskId AND state_revision = $expected`).run({
      status: next.status, revision: next.stateRevision, epoch: next.executionEpoch,
      state: JSON.stringify(next.state), result: next.result ? JSON.stringify(next.result) : null,
      updatedAt: instante(next.updatedAt), taskId: next.taskId, expected: mutation.expectedRevision
    })
    if (Number(updated.changes) !== 1) throw new ConcurrentTaskUpdateError(next.taskId, mutation.expectedRevision)

    if (mutation.plan) {
      const plan = mutation.plan
      this.inserir(db, 'overcore_task_plans', {
        plan_id: plan.planId as string, plan_revision: plan.planRevision as number, task_id: next.taskId,
        plan_fingerprint: (plan.planFingerprint as JsonObject).value as string, document: JSON.stringify(plan),
        created_at: instante(plan.createdAt as string)
      })
    }
    if (mutation.authorization) {
      const { request, decision, enforcement } = mutation.authorization
      const planBinding = request.planBinding as JsonObject
      const limits = decision.limits as JsonObject
      this.inserir(db, 'overcore_task_authorizations', {
        decision_id: decision.decisionId as string, task_id: next.taskId,
        authorization_request_id: request.authorizationRequestId as string,
        plan_id: planBinding.planId as string, plan_revision: planBinding.planRevision as number,
        expires_at: instante(limits.expiresAt as string), request_document: JSON.stringify(request),
        decision_document: JSON.stringify(decision), enforcement_document: JSON.stringify(enforcement)
      })
    }
    this.inserirEvento(db, next.taskId, next.stateRevision, mutation.event)
    if (mutation.outbox) {
      const outbox = mutation.outbox
      this.inserir(db, 'overcore_task_outbox', {
        outbox_id: outbox.outboxId, task_id: outbox.taskId, kind: outbox.kind, payload: JSON.stringify(outbox.payload),
        available_at: instante(outbox.availableAt), attempts: outbox.attempts
      })
    }
    if (mutation.completeOutbox) {
      db.prepare(`UPDATE overcore_task_outbox
        SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), claim_token = NULL, worker_id = NULL, locked_until = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${CASA}
        WHERE outbox_id = ? AND claim_token = ?`).run(mutation.completeOutbox.outboxId, mutation.completeOutbox.claimToken)
    }
    return this.tarefa(db, next.taskId)
  }
}
