import { randomUUID } from 'node:crypto'

import type {
  CasMutation,
  ClaimedMessage,
  ExecutionReceipt,
  JsonObject,
  OutboxMessage,
  StoredTask
} from '../domain/types.js'
import {
  ConcurrentTaskUpdateError,
  DuplicateTaskError,
  type ReconciliationFailure,
  type TaskStore
} from '../ports/task-store.js'
import {
  ConcurrentPreflightUpdateError,
  DuplicatePreflightIntentError,
  type StoredPreflightRevision
} from '../ports/preflight-store.js'
import type { TaskReadinessReport } from '../domain/types.js'
import { ExecutionInterruptedError } from '../ports/execution-control.js'

function copy<T>(value: T): T {
  return structuredClone(value)
}

export class InMemoryTaskStore implements TaskStore {
  private readonly executionLocks = new Map<string, Promise<void>>()

  private async locked<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.executionLocks.get(taskId) ?? Promise.resolve()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => pending)
    this.executionLocks.set(taskId, tail)
    await previous
    try { return await operation() } finally {
      release()
      if (this.executionLocks.get(taskId) === tail) this.executionLocks.delete(taskId)
    }
  }

  async withExecutionFence<T>(claim: ClaimedMessage, epoch: number, mode: 'execute' | 'reconcile', operation: () => Promise<T>, now = new Date()): Promise<T> {
    return this.locked(claim.taskId, async () => {
      const task = this.tasks.get(claim.taskId)
      const message = this.outbox.get(claim.outboxId)
      if (!task || task.executionEpoch !== epoch ||
          !(mode === 'execute' ? ['running', 'verifying'] : ['cancelling']).includes(task.status) ||
          message?.claimToken !== claim.claimToken || !message.lockedUntil || Date.parse(message.lockedUntil) <= now.getTime()) {
        throw new ExecutionInterruptedError()
      }
      return operation()
    })
  }
  readonly tasks = new Map<string, StoredTask>()
  readonly plans = new Map<string, JsonObject>()
  readonly authorizations = new Map<string, { taskId: string; request: JsonObject; decision: JsonObject; enforcement: JsonObject }>()
  readonly events: CasMutation['event'][] = []
  readonly outbox = new Map<string, OutboxMessage>()
  readonly executionReceipts = new Map<string, ExecutionReceipt>()
  readonly preflightStreams = new Map<string, { idempotencyKey: string; latestRevision: number }>()
  readonly preflightRevisions = new Map<string, StoredPreflightRevision>()
  readonly preflightReports = new Map<string, TaskReadinessReport>()
  readonly reconciliationLeases = new Map<string, { ownerId: string; claimToken: string; until: string }>()

  private preflightKey(draftId: string, revision: number): string {
    return `${draftId}:${revision}`
  }

  private planKey(taskId: string, planId: string, planRevision: number): string {
    return `${taskId}:${planId}:${planRevision}`
  }

  async findPreflightRevision(draftId: string, revision: number): Promise<StoredPreflightRevision | null> {
    const record = this.preflightRevisions.get(this.preflightKey(draftId, revision))
    return record ? copy(record) : null
  }

  async findPreflightReport(reportId: string): Promise<TaskReadinessReport | null> {
    const report = this.preflightReports.get(reportId)
    return report ? copy(report) : null
  }

  async findLatestPreflightByIdempotencyKey(idempotencyKey: string): Promise<StoredPreflightRevision | null> {
    const stream = [...this.preflightStreams.entries()].find(([, item]) => item.idempotencyKey === idempotencyKey)
    if (!stream) return null
    return this.findPreflightRevision(stream[0], stream[1].latestRevision)
  }

  async appendPreflightRevision(
    record: StoredPreflightRevision,
    expectedPreviousRevision: number
  ): Promise<StoredPreflightRevision> {
    if (record.revision !== expectedPreviousRevision + 1) {
      throw new Error('A revisão persistida precisa avançar exatamente uma posição.')
    }
    const key = this.preflightKey(record.draftId, record.revision)
    const existing = this.preflightRevisions.get(key)
    if (existing) {
      if (existing.draftFingerprint.value === record.draftFingerprint.value) return copy(existing)
      throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
    }
    const other = [...this.preflightStreams.entries()].find(([, item]) =>
      item.idempotencyKey === record.idempotencyKey
    )
    if (other && other[0] !== record.draftId) throw new DuplicatePreflightIntentError(other[0])
    const stream = this.preflightStreams.get(record.draftId)
    if (stream) {
      if (stream.idempotencyKey !== record.idempotencyKey) {
        throw new DuplicatePreflightIntentError(record.draftId)
      }
      if (stream.latestRevision !== expectedPreviousRevision) {
        throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
      }
    } else if (expectedPreviousRevision !== 0) {
      throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
    }
    this.preflightRevisions.set(key, copy(record))
    this.preflightReports.set(record.reportId, copy(record.report))
    this.preflightStreams.set(record.draftId, {
      idempotencyKey: record.idempotencyKey,
      latestRevision: record.revision
    })
    return copy(record)
  }

  async create(task: StoredTask, event: CasMutation['event']): Promise<StoredTask> {
    const existing = [...this.tasks.values()].find((item) => item.idempotencyKey === task.idempotencyKey)
    if (existing) throw new DuplicateTaskError(existing.taskId)
    this.tasks.set(task.taskId, copy(task))
    this.events.push(copy(event))
    return copy(task)
  }

  async findById(taskId: string): Promise<StoredTask | null> {
    const task = this.tasks.get(taskId)
    return task ? copy(task) : null
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredTask | null> {
    const task = [...this.tasks.values()].find((item) => item.idempotencyKey === idempotencyKey)
    return task ? copy(task) : null
  }

  async findPlan(taskId: string, planId: string, planRevision: number): Promise<JsonObject | null> {
    const plan = this.plans.get(this.planKey(taskId, planId, planRevision))
    if (!plan) return null
    return copy(plan)
  }

  async findAuthorization(taskId: string, decisionId: string) {
    const authorization = this.authorizations.get(decisionId)
    if (!authorization || authorization.taskId !== taskId) return null
    return copy({
      request: authorization.request,
      decision: authorization.decision,
      enforcement: authorization.enforcement
    })
  }

  async listReconciliationCandidates(limit: number, now = new Date()): Promise<StoredTask[]> {
    return [...this.tasks.values()]
      .filter((task) => task.status === 'accepted' || task.status === 'planning' || task.status === 'ready' || task.status === 'cancelling')
      .filter((task) => {
        const lease = this.reconciliationLeases.get(task.taskId)
        return !lease || Date.parse(lease.until) <= now.getTime()
      })
      .filter((task) => !task.reconciliation || Date.parse(task.reconciliation.retryAt) <= now.getTime())
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, Math.max(0, limit))
      .map(copy)
  }

  async claimReconciliation(
    taskId: string,
    ownerId: string,
    leaseMs: number,
    now = new Date()
  ): Promise<string | null> {
    const task = this.tasks.get(taskId)
    if (!task || (task.status !== 'accepted' && task.status !== 'planning' && task.status !== 'ready')) return null
    if (task.reconciliation && Date.parse(task.reconciliation.retryAt) > now.getTime()) return null
    const current = this.reconciliationLeases.get(taskId)
    if (current && Date.parse(current.until) > now.getTime()) return null
    const claimToken = `${ownerId}:${randomUUID()}`
    this.reconciliationLeases.set(taskId, {
      ownerId,
      claimToken,
      until: new Date(now.getTime() + leaseMs).toISOString()
    })
    return claimToken
  }

  async deferReconciliation(
    taskId: string,
    claimToken: string,
    failure: ReconciliationFailure
  ): Promise<void> {
    const lease = this.reconciliationLeases.get(taskId)
    const task = this.tasks.get(taskId)
    if (!task || lease?.claimToken !== claimToken) {
      throw new Error('Lease da reconciliação não confere ao adiar a tarefa.')
    }
    task.reconciliation = {
      failureCount: (task.reconciliation?.failureCount ?? 0) + 1,
      retryAt: failure.retryAt.toISOString(),
      errorCode: failure.code,
      errorFingerprint: failure.errorFingerprint,
      lastErrorAt: failure.occurredAt.toISOString()
    }
    this.tasks.set(taskId, copy(task))
    this.reconciliationLeases.delete(taskId)
  }

  async releaseReconciliation(taskId: string, claimToken: string): Promise<void> {
    const lease = this.reconciliationLeases.get(taskId)
    if (lease?.claimToken === claimToken) {
      this.reconciliationLeases.delete(taskId)
      const task = this.tasks.get(taskId)
      if (task) {
        delete task.reconciliation
        this.tasks.set(taskId, copy(task))
      }
    }
  }

  async compareAndSwap(mutation: CasMutation): Promise<StoredTask> {
    return this.locked(mutation.next.taskId, () => this.commitMutation(mutation))
  }

  private async commitMutation(mutation: CasMutation): Promise<StoredTask> {
    const current = this.tasks.get(mutation.next.taskId)
    if (!current || current.stateRevision !== mutation.expectedRevision) {
      throw new ConcurrentTaskUpdateError(mutation.next.taskId, mutation.expectedRevision)
    }
    if (mutation.next.stateRevision !== mutation.expectedRevision + 1) {
      throw new Error('CAS precisa avançar exatamente uma revisão.')
    }
    if (mutation.completeOutbox) {
      const message = this.outbox.get(mutation.completeOutbox.outboxId)
      if (!message || message.claimToken !== mutation.completeOutbox.claimToken) {
        throw new Error('Lease da outbox não confere no fechamento transacional.')
      }
    }
    const next = copy(mutation.next)
    if (next.status !== 'accepted' && next.status !== 'planning' && next.status !== 'ready') {
      delete next.reconciliation
    }
    this.tasks.set(next.taskId, next)
    this.events.push(copy(mutation.event))
    if (mutation.outbox) this.outbox.set(mutation.outbox.outboxId, copy(mutation.outbox))
    if (mutation.plan) {
      this.plans.set(
        this.planKey(mutation.next.taskId, String(mutation.plan.planId), Number(mutation.plan.planRevision)),
        copy(mutation.plan)
      )
    }
    if (mutation.authorization) {
      this.authorizations.set(String(mutation.authorization.decision.decisionId), {
        taskId: mutation.next.taskId,
        ...copy(mutation.authorization)
      })
    }
    if (mutation.completeOutbox) {
      this.outbox.delete(mutation.completeOutbox.outboxId)
    }
    return copy(mutation.next)
  }

  async findExecutionReceipt(outboxId: string): Promise<ExecutionReceipt | null> {
    const receipt = this.executionReceipts.get(outboxId)
    return receipt ? copy(receipt) : null
  }

  async saveExecutionReceipt(receipt: ExecutionReceipt, claimToken: string, now = new Date()): Promise<ExecutionReceipt> {
    const message = this.outbox.get(receipt.outboxId)
    if (
      !message ||
      message.claimToken !== claimToken ||
      !message.lockedUntil ||
      Date.parse(message.lockedUntil) <= now.getTime()
    ) {
      throw new Error('Lease da outbox nao permite persistir o recibo de execucao.')
    }
    const existing = this.executionReceipts.get(receipt.outboxId)
    if (existing) {
      if (existing.payloadFingerprint.value !== receipt.payloadFingerprint.value) {
        throw new Error(`Recibo da outbox ${receipt.outboxId} possui outro conteudo.`)
      }
      return copy(existing)
    }
    this.executionReceipts.set(receipt.outboxId, copy(receipt))
    return copy(receipt)
  }

  async extendOutboxLease(
    outboxId: string,
    claimToken: string,
    leaseMs: number,
    now = new Date()
  ): Promise<void> {
    const message = this.outbox.get(outboxId)
    if (
      !message ||
      message.claimToken !== claimToken ||
      !message.lockedUntil ||
      Date.parse(message.lockedUntil) <= now.getTime()
    ) {
      throw new Error('Lease da outbox nao pode ser renovado.')
    }
    message.lockedUntil = new Date(now.getTime() + leaseMs).toISOString()
    this.outbox.set(outboxId, copy(message))
  }

  async claimOutbox(workerId: string, leaseMs: number, now = new Date()): Promise<ClaimedMessage | null> {
    const candidate = [...this.outbox.values()]
      .filter((item) => Date.parse(item.availableAt) <= now.getTime())
      .filter((item) => !item.lockedUntil || Date.parse(item.lockedUntil) <= now.getTime())
      .sort((a, b) => a.availableAt.localeCompare(b.availableAt))[0]
    if (!candidate) return null
    const result = await this.locked(candidate.taskId, async () => {
      const current = this.outbox.get(candidate.outboxId)
      if (!current || (current.lockedUntil && Date.parse(current.lockedUntil) > now.getTime())) return null
      const claimed: ClaimedMessage = {
        ...copy(current),
        attempts: current.attempts + 1,
        claimToken: `${workerId}:${randomUUID()}`,
        lockedUntil: new Date(now.getTime() + leaseMs).toISOString()
      }
      this.outbox.set(claimed.outboxId, copy(claimed))
      return claimed
    })
    return result ?? this.claimOutbox(workerId, leaseMs, now)
  }

  async completeOutbox(outboxId: string, claimToken: string): Promise<void> {
    const message = this.outbox.get(outboxId)
    if (!message || message.claimToken !== claimToken) throw new Error('Lease da outbox não confere.')
    this.outbox.delete(outboxId)
  }

  async releaseOutbox(outboxId: string, claimToken: string, errorFingerprint: string, retryAt: Date): Promise<void> {
    const message = this.outbox.get(outboxId)
    if (!message || message.claimToken !== claimToken) throw new Error('Lease da outbox não confere.')
    const released: OutboxMessage = {
      ...message,
      availableAt: retryAt.toISOString(),
      payload: { ...message.payload, lastErrorFingerprint: errorFingerprint }
    }
    delete released.claimToken
    delete released.lockedUntil
    this.outbox.set(outboxId, released)
  }
}
