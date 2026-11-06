import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
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
import { ExecutionInterruptedError } from '../../../ports/execution-control.js'
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

interface ExecutionReceiptRow {
  receipt_id: string
  outbox_id: string
  task_id: string
  execution_epoch: number
  payload: string
  payload_fingerprint: string
  recorded_at: string
}

interface OutboxRow {
  outbox_id: string
  task_id: string
  kind: ClaimedMessage['kind']
  payload: string
  available_at: string
  attempts: number
  claim_token: string
  locked_until: string
}

const CHAVES_DA_TAREFA = new Set(['task_id', 'request_id', 'idempotency_key'])

function depois(agora: Date, ms: number): string {
  return new Date(agora.getTime() + ms).toISOString()
}

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

/**
 * Estado da cerca de um arquivo (ADR-023 D3). No PostgreSQL o FOR UPDATE da cerca bloqueia o CAS
 * e esconde a mensagem do SKIP LOCKED; aqui a trava por tarefa faz o primeiro e `emCerca` o segundo.
 * Vale dentro do processo; a posse (D2) garante que só um processo escreve no arquivo.
 */
interface Cerca { travas: Map<string, Promise<void>>; emCerca: Set<string> }

const cercas = new Map<string, Cerca>()

function cercaDo(arquivo: string): Cerca {
  const chave = resolve(arquivo)
  let cerca = cercas.get(chave)
  if (!cerca) {
    cerca = { travas: new Map(), emCerca: new Set() }
    cercas.set(chave, cerca)
  }
  return cerca
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

  async listTasks(query: { limit: number; statuses?: StoredTask['status'][] }): Promise<StoredTask[]> {
    const statuses = query.statuses ?? []
    const filtro = statuses.length ? `WHERE status IN (${statuses.map(() => '?').join(', ')})` : ''
    const rows = this.ler((db) => db.prepare(`SELECT * FROM overcore_tasks ${filtro}
      ORDER BY updated_at DESC, task_id
      LIMIT ?`).all(...statuses, Math.max(0, query.limit)) as unknown as TaskRow[])
    return rows.map(mapTask)
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
    return this.travado(mutation.next.taskId, async () => this.escrever((db) => this.aplicarMutacao(db, mutation)))
  }

  async withExecutionFence<T>(claim: ClaimedMessage, epoch: number, mode: 'execute' | 'reconcile', operation: () => Promise<T>, now = new Date()): Promise<T> {
    return this.travado(claim.taskId, async () => {
      // Checagem curta: a transação fecha antes da operação, que pode esperar rede, disco ou agente (D4).
      const valida = this.escrever((db) => {
        const lease = db.prepare(`SELECT 1 FROM overcore_task_outbox WHERE outbox_id = ? AND task_id = ? AND claim_token = ?
          AND processed_at IS NULL AND locked_until > ?`).get(claim.outboxId, claim.taskId, claim.claimToken, instante(now))
        const task = db.prepare('SELECT status, execution_epoch FROM overcore_tasks WHERE task_id = ?')
          .get(claim.taskId) as { status: TaskStatus; execution_epoch: number } | undefined
        const estados: TaskStatus[] = mode === 'execute' ? ['running', 'verifying'] : ['cancelling']
        return Boolean(lease && task && task.execution_epoch === epoch && estados.includes(task.status))
      })
      if (!valida) throw new ExecutionInterruptedError()
      const { emCerca } = cercaDo(this.arquivo)
      emCerca.add(claim.outboxId)
      try { return await operation() } finally { emCerca.delete(claim.outboxId) }
    })
  }

  /** Serializa as operações da mesma tarefa neste processo, no molde do `locked` do InMemoryTaskStore. */
  private async travado<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const { travas } = cercaDo(this.arquivo)
    const previous = travas.get(taskId) ?? Promise.resolve()
    let release!: () => void
    const pending = new Promise<void>((resolveTrava) => { release = resolveTrava })
    const tail = previous.then(() => pending)
    travas.set(taskId, tail)
    await previous
    try { return await operation() } finally {
      release()
      if (travas.get(taskId) === tail) travas.delete(taskId)
    }
  }

  async listReconciliationCandidates(limit: number, now = new Date()): Promise<StoredTask[]> {
    const rows = this.ler((db) => db.prepare(`SELECT * FROM overcore_tasks
      WHERE status IN ('accepted', 'planning', 'ready', 'cancelling')
        AND (reconciliation_until IS NULL OR reconciliation_until <= $now)
        AND (reconciliation_retry_at IS NULL OR reconciliation_retry_at <= $now)
      ORDER BY updated_at, task_id
      LIMIT $limit`).all({ now: instante(now), limit: Math.max(0, limit) }) as unknown as TaskRow[])
    return rows.map(mapTask)
  }

  async claimReconciliation(taskId: string, ownerId: string, leaseMs: number, now = new Date()): Promise<string | null> {
    const claimToken = `${ownerId}:${randomUUID()}`
    const row = this.escrever((db) => db.prepare(`UPDATE overcore_tasks
      SET reconciliation_owner = $owner, reconciliation_token = $token, reconciliation_until = $until, ${CASA}
      WHERE task_id = $taskId
        AND status IN ('accepted', 'planning', 'ready')
        AND (reconciliation_until IS NULL OR reconciliation_until <= $now)
        AND (reconciliation_retry_at IS NULL OR reconciliation_retry_at <= $now)
      RETURNING reconciliation_token`).get({
      owner: ownerId, token: claimToken, until: depois(now, leaseMs), taskId, now: instante(now)
    }) as { reconciliation_token: string } | undefined)
    return row?.reconciliation_token ?? null
  }

  async deferReconciliation(taskId: string, claimToken: string, failure: ReconciliationFailure): Promise<void> {
    const mudou = this.escrever((db) => Number(db.prepare(`UPDATE overcore_tasks
      SET reconciliation_owner = NULL, reconciliation_token = NULL, reconciliation_until = NULL,
          reconciliation_failure_count = reconciliation_failure_count + 1,
          reconciliation_retry_at = $retryAt, reconciliation_error_code = $code,
          reconciliation_error_fingerprint = $fingerprint, reconciliation_last_error_at = $occurredAt, ${CASA}
      WHERE task_id = $taskId AND reconciliation_token = $token`).run({
      retryAt: instante(failure.retryAt), code: failure.code, fingerprint: failure.errorFingerprint,
      occurredAt: instante(failure.occurredAt), taskId, token: claimToken
    }).changes))
    if (mudou !== 1) throw new Error('Lease da reconciliação não confere ao adiar a tarefa.')
  }

  async releaseReconciliation(taskId: string, claimToken: string): Promise<void> {
    this.escrever((db) => db.prepare(`UPDATE overcore_tasks
      SET reconciliation_owner = NULL, reconciliation_token = NULL, reconciliation_until = NULL,
          reconciliation_failure_count = 0, reconciliation_retry_at = NULL, reconciliation_error_code = NULL,
          reconciliation_error_fingerprint = NULL, reconciliation_last_error_at = NULL, ${CASA}
      WHERE task_id = ? AND reconciliation_token = ?`).run(taskId, claimToken))
  }

  async claimOutbox(workerId: string, leaseMs: number, now = new Date()): Promise<ClaimedMessage | null> {
    const claimToken = `${workerId}:${randomUUID()}`
    const row = this.escrever((db) => {
      // Mensagem em cerca fica fora mesmo com o lease vencido, como o SKIP LOCKED do PostgreSQL.
      // rowid desempata o created_at de mesmo milissegundo na ordem de inserção.
      const candidate = db.prepare(`SELECT outbox_id FROM overcore_task_outbox
        WHERE processed_at IS NULL AND available_at <= $now AND (locked_until IS NULL OR locked_until <= $now)
          AND outbox_id NOT IN (SELECT value FROM json_each($cerca))
        ORDER BY available_at, created_at, rowid
        LIMIT 1`).get({ now: instante(now), cerca: JSON.stringify([...cercaDo(this.arquivo).emCerca]) }) as { outbox_id: string } | undefined
      if (!candidate) return undefined
      return db.prepare(`UPDATE overcore_task_outbox
        SET claim_token = $token, worker_id = $worker, locked_until = $until, attempts = attempts + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${CASA}
        WHERE outbox_id = $outboxId
        RETURNING outbox_id, task_id, kind, payload, available_at, attempts, claim_token, locked_until`).get({
        token: claimToken, worker: workerId, until: depois(now, leaseMs), outboxId: candidate.outbox_id
      }) as unknown as OutboxRow
    })
    if (!row) return null
    return {
      outboxId: row.outbox_id,
      taskId: row.task_id,
      kind: row.kind,
      payload: lerJson<JsonObject>(row.payload),
      availableAt: row.available_at,
      attempts: row.attempts,
      claimToken: row.claim_token,
      lockedUntil: row.locked_until
    }
  }

  async extendOutboxLease(outboxId: string, claimToken: string, leaseMs: number, now = new Date()): Promise<void> {
    const mudou = this.escrever((db) => Number(db.prepare(`UPDATE overcore_task_outbox
      SET locked_until = $until, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${CASA}
      WHERE outbox_id = $outboxId AND claim_token = $token AND processed_at IS NULL AND locked_until > $now`).run({
      until: depois(now, leaseMs), outboxId, token: claimToken, now: instante(now)
    }).changes))
    if (mudou !== 1) throw new Error('Lease da outbox nao pode ser renovado.')
  }

  async completeOutbox(outboxId: string, claimToken: string): Promise<void> {
    const mudou = this.escrever((db) => Number(db.prepare(`UPDATE overcore_task_outbox
      SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), claim_token = NULL, worker_id = NULL, locked_until = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${CASA}
      WHERE outbox_id = ? AND claim_token = ? AND processed_at IS NULL`).run(outboxId, claimToken).changes))
    if (mudou !== 1) throw new Error('Lease da outbox não confere.')
  }

  async releaseOutbox(outboxId: string, claimToken: string, errorFingerprint: string, retryAt: Date): Promise<void> {
    const mudou = this.escrever((db) => Number(db.prepare(`UPDATE overcore_task_outbox
      SET available_at = $retryAt, claim_token = NULL, worker_id = NULL, locked_until = NULL,
          last_error_fingerprint = $fingerprint, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${CASA}
      WHERE outbox_id = $outboxId AND claim_token = $token AND processed_at IS NULL`).run({
      retryAt: instante(retryAt), fingerprint: errorFingerprint, outboxId, token: claimToken
    }).changes))
    if (mudou !== 1) throw new Error('Lease da outbox não confere.')
  }

  async findExecutionReceipt(outboxId: string): Promise<ExecutionReceipt | null> {
    return this.ler((db) => this.recibo(db, outboxId))
  }

  /** Idempotente por outbox: o mesmo conteúdo devolve o recibo gravado; outro conteúdo é recusado. */
  async saveExecutionReceipt(receipt: ExecutionReceipt, claimToken: string, now = new Date()): Promise<ExecutionReceipt> {
    return this.escrever((db) => {
      const lease = db.prepare(`SELECT 1 FROM overcore_task_outbox
        WHERE outbox_id = ? AND claim_token = ? AND processed_at IS NULL AND locked_until > ?`)
        .get(receipt.outboxId, claimToken, instante(now))
      if (!lease) throw new Error('Lease da outbox nao permite persistir o recibo de execucao.')
      db.prepare(`INSERT INTO overcore_task_execution_receipts
          (receipt_id, outbox_id, task_id, execution_epoch, payload, payload_fingerprint, recorded_at, origem_maquina)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (outbox_id) DO NOTHING`).run(
        receipt.receiptId, receipt.outboxId, receipt.taskId, receipt.executionEpoch, JSON.stringify(receipt.payload),
        receipt.payloadFingerprint.value, instante(receipt.recordedAt), this.origemMaquina)
      const stored = this.recibo(db, receipt.outboxId)
      if (!stored) throw new Error(`Recibo da outbox ${receipt.outboxId} nao foi persistido.`)
      if (stored.payloadFingerprint.value !== receipt.payloadFingerprint.value) {
        throw new Error(`Recibo da outbox ${receipt.outboxId} possui outro conteudo.`)
      }
      return stored
    })
  }

  private recibo(db: DatabaseSync, outboxId: string): ExecutionReceipt | null {
    const row = db.prepare(`SELECT receipt_id, outbox_id, task_id, execution_epoch, payload, payload_fingerprint, recorded_at
      FROM overcore_task_execution_receipts WHERE outbox_id = ?`).get(outboxId) as ExecutionReceiptRow | undefined
    if (!row) return null
    return {
      receiptId: row.receipt_id,
      outboxId: row.outbox_id,
      taskId: row.task_id,
      executionEpoch: row.execution_epoch,
      payload: lerJson<JsonObject>(row.payload),
      payloadFingerprint: { algorithm: 'sha256-jcs-v1', value: row.payload_fingerprint as `sha256:${string}` },
      recordedAt: row.recorded_at
    }
  }

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
