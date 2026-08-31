import type {
  CasMutation,
  ClaimedMessage,
  JsonObject,
  StoredTask
} from '../domain/types.js'
import type { AgentRuntimeAuthorization } from './agent-runtime.js'
import type { PreflightStore } from './preflight-store.js'

export interface StoredTaskAuthorization {
  request: JsonObject
  decision: JsonObject
  enforcement: JsonObject
}

export interface ReconciliationFailure {
  code: string
  errorFingerprint: string
  occurredAt: Date
  retryAt: Date
}

export class ConcurrentTaskUpdateError extends Error {
  constructor(taskId: string, expectedRevision: number) {
    super(`A tarefa ${taskId} não está mais na revisão ${expectedRevision}.`)
    this.name = 'ConcurrentTaskUpdateError'
  }
}

export class DuplicateTaskError extends Error {
  constructor(readonly existingTaskId: string) {
    super(`A chave idempotente já pertence à tarefa ${existingTaskId}.`)
    this.name = 'DuplicateTaskError'
  }
}

export class AuthorityProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'AuthorityProviderError'
  }
}

export interface TaskStore extends PreflightStore {
  create(task: StoredTask, event: CasMutation['event']): Promise<StoredTask>
  findById(taskId: string): Promise<StoredTask | null>
  findByIdempotencyKey(idempotencyKey: string): Promise<StoredTask | null>
  findPlan(taskId: string, planId: string, planRevision: number): Promise<JsonObject | null>
  findAuthorization(taskId: string, decisionId: string): Promise<StoredTaskAuthorization | null>
  listReconciliationCandidates(limit: number, now?: Date): Promise<StoredTask[]>
  claimReconciliation(taskId: string, ownerId: string, leaseMs: number, now?: Date): Promise<string | null>
  deferReconciliation(taskId: string, claimToken: string, failure: ReconciliationFailure): Promise<void>
  releaseReconciliation(taskId: string, claimToken: string): Promise<void>
  compareAndSwap(mutation: CasMutation): Promise<StoredTask>
  claimOutbox(workerId: string, leaseMs: number, now?: Date): Promise<ClaimedMessage | null>
  completeOutbox(outboxId: string, claimToken: string): Promise<void>
  releaseOutbox(outboxId: string, claimToken: string, errorFingerprint: string, retryAt: Date): Promise<void>
}

export interface AuthorityProvider {
  evaluate(request: JsonObject, signal?: AbortSignal): Promise<JsonObject>
}

export interface InspectionExecutor {
  execute(input: {
    runId: string
    repositoryUri: string
    objective: string
    timeoutMs: number
    maxTokens?: number
    maxCostUsd?: number
    authorization: AgentRuntimeAuthorization
  }): Promise<JsonObject>
}
