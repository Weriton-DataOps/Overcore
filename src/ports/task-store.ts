import type {
  CasMutation,
  ClaimedMessage,
  JsonObject,
  StoredTask
} from '../domain/types.js'
import type { AgentRuntimeAuthorization } from './agent-runtime.js'
import type { PreflightStore } from './preflight-store.js'

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

export interface TaskStore extends PreflightStore {
  create(task: StoredTask, event: CasMutation['event']): Promise<StoredTask>
  findById(taskId: string): Promise<StoredTask | null>
  findByIdempotencyKey(idempotencyKey: string): Promise<StoredTask | null>
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
