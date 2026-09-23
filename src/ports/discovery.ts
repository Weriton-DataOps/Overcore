import type {
  JsonObject,
  ReadinessCheck,
  TaskDraft,
  TaskReadinessReport
} from '../domain/types.js'

export type DiscoveryDepth = 'light' | 'standard' | 'deep'

export interface DiscoveryProfile {
  depth: DiscoveryDepth
  reason: string
}

export interface AppliedDecision {
  answer: JsonObject
  decision: JsonObject
  selectedOption: JsonObject
  sourceReport: TaskReadinessReport
}

export interface DiscoveryRequest {
  draft: TaskDraft
  profile: DiscoveryProfile
  generatedAt: string
  appliedDecisions: AppliedDecision[]
  /** Decisions already raised by deterministic checks in this same revision. */
  pendingDecisions?: JsonObject[]
}

export interface DiscoveryAssessment {
  readinessChecks: ReadinessCheck[]
  automaticDecisions: JsonObject[]
  requiredDecisions: JsonObject[]
  evidence: JsonObject[]
  failure?: JsonObject
}

/**
 * Achado ainda não é decisão. O assessor pode apontar uma lacuna, mas o
 * Preflight é quem converte isso em uma pergunta rastreável ao proprietário.
 */
export interface DiscoveryQuestion {
  topic: 'scope' | 'target' | 'behavior' | 'authority' | 'output' | 'compatibility' | 'risk' | 'dependency' | 'budget' | 'other'
  question: string
  reason: string
}

export interface DiscoveryAdvice {
  summary: string
  questions: DiscoveryQuestion[]
  provenance: {
    engine: 'anthropic-claude-agent-sdk'
    model: string
    sessionId: string
    outputDigest: string
    turns: number
  }
}

/**
 * Porta opcional e sem poder de efeito. Um assessor lê o TaskDraft e o resumo
 * de decisões validadas/pendentes e devolve perguntas candidatas; não recebe ferramentas,
 * referências abertas, autoridade de execução nem acesso ao Task State.
 */
export interface DiscoveryAdvisor {
  advise(request: DiscoveryRequest): Promise<DiscoveryAdvice>
}

/**
 * Porta neutra da descoberta preparatória.
 *
 * Uma implementação pode ser determinística ou, futuramente, usar um agente.
 * O retorno continua sendo evidência estruturada; a porta não executa a tarefa.
 */
export interface DiscoveryPort {
  inspect(request: DiscoveryRequest): Promise<DiscoveryAssessment>
}
