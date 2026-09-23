export type AgentRuntimeTool = 'Read' | 'Glob' | 'Grep'

export interface AgentRuntimeAuthorization {
  enforcementId: string
  enforcementFingerprint: string
  expiresAt: string
  operations: string[]
  requiredControls: string[]
}

export interface AgentRuntimeRequest {
  /** Execução lê recursos; Discovery lê somente o documento já recebido. */
  purpose?: 'execution' | 'discovery'
  runId: string
  cwd: string
  objective: string
  instructions: string
  tools: AgentRuntimeTool[]
  maxTurns: number
  timeoutMs: number
  maxCostUsd?: number
  resumeSessionId?: string
  authorization: AgentRuntimeAuthorization
}

export type AgentRuntimeEventType =
  | 'runtime-started'
  | 'assistant-text'
  | 'tool-requested'
  | 'tool-allowed'
  | 'tool-denied'
  | 'rate-limit'
  | 'runtime-result'

export interface AgentRuntimeEvent {
  sequence: number
  type: AgentRuntimeEventType
  occurredAt: string
  data: Record<string, unknown>
}

export interface AgentRuntimeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  estimatedCostUsd: number
}

export interface AgentRuntimeResult {
  engine: 'anthropic-claude-agent-sdk'
  sdkVersion: string
  authSource: 'oauth-login'
  sessionId: string
  model: string
  output: string
  durationMs: number
  turns: number
  usage: AgentRuntimeUsage
  permissionDenials: number
  events: AgentRuntimeEvent[]
}

export type AgentRuntimeEventSink = (event: AgentRuntimeEvent) => void | Promise<void>

export interface AgentRuntimePort {
  run(
    request: AgentRuntimeRequest,
    onEvent?: AgentRuntimeEventSink,
    signal?: AbortSignal
  ): Promise<AgentRuntimeResult>
}
