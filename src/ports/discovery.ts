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
}

export interface DiscoveryAssessment {
  readinessChecks: ReadinessCheck[]
  automaticDecisions: JsonObject[]
  requiredDecisions: JsonObject[]
  evidence: JsonObject[]
  failure?: JsonObject
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
