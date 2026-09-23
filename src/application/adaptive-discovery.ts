import { fingerprint, stableId } from '../domain/fingerprint.js'
import type { JsonObject, ReadinessCheck, ReadinessCheckId } from '../domain/types.js'
import type {
  DiscoveryAdvice,
  DiscoveryAdvisor,
  DiscoveryAssessment,
  DiscoveryPort,
  DiscoveryQuestion,
  DiscoveryRequest
} from '../ports/discovery.js'

const CHECK_BY_TOPIC: Record<DiscoveryQuestion['topic'], ReadinessCheckId> = {
  scope: 'objective-clear', target: 'context-resolvable', behavior: 'objective-clear',
  authority: 'authority-sufficient', output: 'output-defined', compatibility: 'criteria-testable',
  risk: 'rollback-ready', dependency: 'context-resolvable', budget: 'budget-feasible', other: 'objective-clear'
}

function clipped(value: string, limit = 1_800): string {
  return value.replace(/[\u0000-\u001F]+/gu, ' ').trim().slice(0, limit)
}

function questionKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim()
}

function evidence(request: DiscoveryRequest, summary: string, provenance: JsonObject = {}): JsonObject {
  const basis = { draftId: request.draft.draftId, revision: request.draft.revision, summary, provenance }
  return {
    evidenceId: stableId('evidence-discovery-advisor', JSON.stringify(basis)),
    kind: 'inspection', capturedAt: request.generatedAt, summary,
    digest: fingerprint(basis).value,
    sourceRefs: request.draft.context.references.map((reference) => reference.refId)
  }
}

function requiredDecision(request: DiscoveryRequest, question: DiscoveryQuestion, evidenceRef: string): JsonObject {
  const seed = `${request.draft.draftId}:${request.draft.revision}:${question.topic}:${question.question}`
  const decisionId = stableId('decision-discovery-advisor', seed)
  const clarifyId = stableId('option-clarify-discovery', decisionId)
  const reviseId = stableId('option-revise-discovery', decisionId)
  return {
    decisionId,
    topic: question.topic,
    question: clipped(question.question),
    reason: clipped(question.reason),
    options: [
      {
        optionId: clarifyId,
        label: 'Esclarecer e confirmar',
        consequence: 'A próxima revisão registra a informação necessária para o Preflight continuar.'
      },
      {
        optionId: reviseId,
        label: 'Revisar o pedido',
        consequence: 'A próxima revisão ajusta objetivo, contexto, critério, limite ou saída.'
      }
    ],
    recommendedOptionId: clarifyId,
    impactIfUnresolved: 'O Preflight não deve adivinhar uma decisão material antes de liberar execução.',
    evidenceRefs: [evidenceRef]
  }
}

function attachQuestions(
  baseline: DiscoveryAssessment,
  request: DiscoveryRequest,
  advice: DiscoveryAdvice
): DiscoveryAssessment {
  const summary = clipped(advice.summary)
  const advisorEvidence = evidence(request, summary, {
    engine: advice.provenance.engine,
    model: advice.provenance.model,
    sessionId: advice.provenance.sessionId,
    outputDigest: advice.provenance.outputDigest,
    turns: advice.provenance.turns
  })
  const evidenceRef = String(advisorEvidence.evidenceId)
  const seen = new Set(baseline.requiredDecisions.map((item) => questionKey(String(item.question))))
  const questions = advice.questions.slice(0, 3).filter((question) => {
    const key = questionKey(question.question)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (questions.length === 0) {
    return { ...baseline, evidence: [...baseline.evidence, advisorEvidence] }
  }
  const decisions = questions.map((question) => requiredDecision(request, question, evidenceRef))
  const byCheck = new Map<ReadinessCheckId, string[]>()
  for (const decision of decisions) {
    const topic = String(decision.topic) as DiscoveryQuestion['topic']
    const refs = byCheck.get(CHECK_BY_TOPIC[topic]) ?? []
    refs.push(String(decision.decisionId))
    byCheck.set(CHECK_BY_TOPIC[topic], refs)
  }
  const readinessChecks = baseline.readinessChecks.map((item): ReadinessCheck => {
    const decisionRefs = byCheck.get(item.checkId)
    if (!decisionRefs) return item
    return {
      ...item,
      status: 'needs-decision',
      summary: `${item.summary} A Discovery assistida encontrou uma decisão material adicional.`,
      evidenceRefs: [...new Set([...item.evidenceRefs, evidenceRef])],
      decisionRefs: [...new Set([...item.decisionRefs, ...decisionRefs])]
    }
  })
  return {
    ...baseline,
    readinessChecks,
    requiredDecisions: [...baseline.requiredDecisions, ...decisions],
    evidence: [...baseline.evidence, advisorEvidence]
  }
}

/**
 * Primeiro roda as regras determinísticas. Quando habilitado, o
 * assessor pode acrescentar perguntas, mas jamais aprovar, negar ou mudar
 * automaticamente a autoridade, o orçamento ou os efeitos.
 */
export class AdaptiveDiscovery implements DiscoveryPort {
  constructor(
    private readonly baseline: DiscoveryPort,
    private readonly advisor?: DiscoveryAdvisor
  ) {}

  async inspect(request: DiscoveryRequest): Promise<DiscoveryAssessment> {
    const assessment = await this.baseline.inspect(request)
    // A small number of fields measures document size, not semantic certainty.
    // Opting into advisor mode must also cover short, ambiguous requests.
    if (!this.advisor || assessment.failure) return assessment
    try {
      return attachQuestions(assessment, request, await this.advisor.advise({
        ...request, pendingDecisions: assessment.requiredDecisions
      }))
    } catch (error) {
      const summary = `Discovery assistida indisponível; checks determinísticos continuaram válidos: ${clipped(error instanceof Error ? error.message : String(error), 400)}`
      return { ...assessment, evidence: [...assessment.evidence, evidence(request, summary)] }
    }
  }
}
