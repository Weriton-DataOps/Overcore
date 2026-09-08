export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = Record<string, unknown>

export interface Fingerprint {
  algorithm: 'sha256-jcs-v1'
  value: `sha256:${string}`
}

export interface ContextReference {
  refId: string
  uri: string
  kind: 'repository' | 'workspace' | 'file' | 'document' | 'artifact' | 'url' | 'service' | 'other'
  digest?: string
  sensitivity: 'public' | 'internal' | 'restricted'
}

export interface AcceptanceCriterion {
  id: string
  description: string
  verification: {
    method: 'command' | 'test' | 'inspection' | 'schema' | 'external' | 'human'
    expected: string
    procedureRef?: string
  }
}

export interface TaskRequest extends JsonObject {
  contractVersion: '1.0'
  requestId: string
  idempotencyKey: string
  correlationId?: string
  createdAt: string
  preflight: JsonObject
  client: {
    id: string
    kind: 'assistant' | 'cli' | 'api' | 'automation' | 'service' | 'other'
  }
  objective: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  context: {
    summary?: string
    references: ContextReference[]
    assumptions: JsonObject[]
  }
  constraints: JsonObject[]
  authority: {
    mode: 'proceed-within-scope'
    grants: Array<{ resourceRef: string; operations: string[] }>
    expansionBoundaries: string[]
    expiresAt?: string
  }
  acceptanceCriteria: AcceptanceCriterion[]
  budget: {
    maxDurationMs: number
    maxAttempts: number
    maxParallelism: number
    maxTokens?: number
    maxCostUsd?: number
  }
  expectedOutput: JsonObject & { kind: string }
}

export interface TaskDraft extends JsonObject {
  contractVersion: '1.0'
  draftId: string
  revision: number
  idempotencyKey: string
  executionIdempotencyKey: string
  correlationId?: string
  createdAt: string
  client: TaskRequest['client']
  objective: string
  context: {
    summary?: string
    references: ContextReference[]
    assumptions: JsonObject[]
  }
  knownConstraints: JsonObject[]
  knownAcceptanceCriteria: JsonObject[]
  discoveryAuthority: JsonObject & {
    mode: 'inspect-only'
    grants: JsonObject[]
    expiresAt?: string
  }
  availableExecutionAuthority: TaskRequest['authority']
  executionBudget: JsonObject & { source: JsonObject; limits: TaskRequest['budget'] }
  decisionAnswers: JsonObject[]
  preflightBudget: {
    maxDurationMs: number
    maxInspectionOperations: number
  }
  executionHints?: JsonObject & {
    priority?: TaskRequest['priority']
    deadline?: string
    expectedOutputKind?: string
  }
}

export type ReadinessCheckId =
  | 'objective-clear'
  | 'context-resolvable'
  | 'authority-sufficient'
  | 'criteria-testable'
  | 'budget-feasible'
  | 'output-defined'
  | 'rollback-ready'

export type ReadinessCheckStatus = 'passed' | 'failed' | 'needs-decision'

export interface ReadinessCheck extends JsonObject {
  checkId: ReadinessCheckId
  status: ReadinessCheckStatus
  summary: string
  evidenceRefs: string[]
  decisionRefs: string[]
}

export interface TaskReadinessReport extends JsonObject {
  contractVersion: '1.0'
  reportId: string
  draftId: string
  draftRevision: number
  draftFingerprint: Fingerprint
  generatedAt: string
  status: 'ready' | 'decisions-required' | 'not-feasible'
  readinessChecks: ReadinessCheck[]
  automaticDecisions: JsonObject[]
  requiredDecisions: JsonObject[]
  appliedDecisionAnswers: JsonObject[]
  evidence: JsonObject[]
  preparedRequest?: TaskRequest
  preparedRequestFingerprint?: Fingerprint
  requestDerivations?: JsonObject[]
  failure?: JsonObject
}

export type TaskStatus =
  | 'accepted'
  | 'planning'
  | 'ready'
  | 'running'
  | 'verifying'
  | 'blocked'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'

export interface TaskState extends JsonObject {
  modelVersion: '1.0'
  taskId: string
  requestBinding: JsonObject
  acceptedAt: string
  updatedAt: string
  stateRevision: number
  executionEpoch: number
  lifecycle: JsonObject & { state: TaskStatus; enteredAt: string; lastTransitionId: string }
  criterionProgress: JsonObject[]
  usage: JsonObject
  ledger: JsonObject
}

export interface StoredTask {
  taskId: string
  requestId: string
  idempotencyKey: string
  scopeKey: string
  status: TaskStatus
  stateRevision: number
  executionEpoch: number
  request: TaskRequest
  state: TaskState
  result?: JsonObject
  reconciliation?: {
    failureCount: number
    retryAt: string
    errorCode: string
    errorFingerprint: string
    lastErrorAt: string
  }
  createdAt: string
  updatedAt: string
}

export interface OutboxMessage {
  outboxId: string
  taskId: string
  kind: 'execute-inspection'
  payload: JsonObject
  availableAt: string
  attempts: number
  claimToken?: string
  lockedUntil?: string
}

export interface CasMutation {
  expectedRevision: number
  next: StoredTask
  event: {
    eventId: string
    kind: string
    payload: JsonObject
    occurredAt: string
  }
  outbox?: OutboxMessage
  plan?: JsonObject
  authorization?: {
    request: JsonObject
    decision: JsonObject
    enforcement: JsonObject
  }
  completeOutbox?: {
    outboxId: string
    claimToken: string
  }
}

export interface ClaimedMessage extends OutboxMessage {
  claimToken: string
  lockedUntil: string
}

export interface ExecutionReceipt {
  receiptId: string
  outboxId: string
  taskId: string
  executionEpoch: number
  payload: JsonObject
  payloadFingerprint: Fingerprint
  recordedAt: string
}

export interface InspectionEvidence {
  repositoryUri: string
  schemaCount: number
  files: Array<{
    name: string
    readable: boolean
    rootClosed: boolean
    digest: `sha256:${string}`
  }>
  capturedAt: string
  agentRuntime?: {
    engine: 'anthropic-claude-agent-sdk'
    sdkVersion: string
    authSource: 'oauth-login'
    sessionId: string
    model: string
    report: string
    outputDigest: `sha256:${string}`
    durationMs: number
    turns: number
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    estimatedCostUsd: number
    permissionDenials: number
    eventCount: number
  }
}
