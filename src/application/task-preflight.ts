import { canonicalJson, fingerprint, stableId } from '../domain/fingerprint.js'
import type {
  JsonObject,
  ReadinessCheck,
  ReadinessCheckId,
  TaskDraft,
  TaskReadinessReport,
  TaskRequest
} from '../domain/types.js'
import type {
  AppliedDecision,
  DiscoveryPort,
  DiscoveryProfile
} from '../ports/discovery.js'
import type { ContractValidator } from '../contracts/validator.js'
import {
  ConcurrentPreflightUpdateError,
  DuplicatePreflightIntentError,
  type PreflightStore,
  type StoredPreflightRevision
} from '../ports/preflight-store.js'

const CHECK_IDS: ReadinessCheckId[] = [
  'objective-clear',
  'context-resolvable',
  'authority-sufficient',
  'criteria-testable',
  'budget-feasible',
  'output-defined',
  'rollback-ready'
]

export interface PreflightClock {
  now(): Date
}

const defaultClock: PreflightClock = { now: () => new Date() }

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
}

function profileFor(draft: TaskDraft): DiscoveryProfile {
  const score = draft.context.references.length
    + draft.context.assumptions.length * 2
    + draft.knownConstraints.length
    + draft.knownAcceptanceCriteria.length
  if (score <= 4) return { depth: 'light', reason: `Complexidade estrutural inicial ${score}.` }
  if (score <= 12) return { depth: 'standard', reason: `Complexidade estrutural inicial ${score}.` }
  return { depth: 'deep', reason: `Complexidade estrutural inicial ${score}.` }
}

function assertReportFingerprint(report: TaskReadinessReport, declared: unknown): void {
  if (canonicalJson(fingerprint(report)) !== canonicalJson(declared)) {
    throw new Error(`Fingerprint do relatório anterior ${report.reportId} não corresponde à resposta.`)
  }
}

function resolveAnswers(
  draft: TaskDraft,
  reports: TaskReadinessReport[],
  validator: ContractValidator
): AppliedDecision[] {
  const reportById = new Map(reports.map((report) => [report.reportId, report]))
  const answerIds = new Set<string>()
  const decisionIds = new Set<string>()
  return draft.decisionAnswers.map((answer) => {
    const answerId = String(answer.answerId)
    const decisionId = String(answer.decisionId)
    if (answerIds.has(answerId) || decisionIds.has(decisionId)) {
      throw new Error('Uma revisão não pode aplicar duas vezes a mesma resposta ou decisão.')
    }
    answerIds.add(answerId)
    decisionIds.add(decisionId)
    const source = object(answer.sourceReport)
    const report = reportById.get(String(source.reportId))
    if (!report) throw new Error(`Relatório anterior ${String(source.reportId)} não foi fornecido ao Preflight.`)
    validator.taskReadinessReport(report)
    if (report.status !== 'decisions-required') {
      throw new Error(`Relatório ${report.reportId} não possui decisões a responder.`)
    }
    if (report.draftId !== draft.draftId || report.draftRevision >= draft.revision) {
      throw new Error(`Resposta ${answerId} veio de outro draft ou de uma revisão não anterior.`)
    }
    if (source.draftRevision !== report.draftRevision || canonicalJson(source.draftFingerprint) !== canonicalJson(report.draftFingerprint)) {
      throw new Error(`Resposta ${answerId} diverge da revisão declarada no relatório anterior.`)
    }
    assertReportFingerprint(report, source.reportFingerprint)
    const decision = objects(report.requiredDecisions).find((item) => item.decisionId === decisionId)
    if (!decision) throw new Error(`Decisão ${decisionId} não existe no relatório ${report.reportId}.`)
    const selectedOption = objects(decision.options).find((item) => item.optionId === answer.selectedOptionId)
    if (!selectedOption) throw new Error(`Opção ${String(answer.selectedOptionId)} não pertence à decisão ${decisionId}.`)
    return { answer, decision, selectedOption, sourceReport: report }
  })
}

function assertRevisionContinuity(draft: TaskDraft, previous: StoredPreflightRevision | null): void {
  if (!previous) {
    if (draft.revision !== 1 || draft.decisionAnswers.length > 0) {
      throw new ConcurrentPreflightUpdateError(draft.draftId, draft.revision - 1)
    }
    return
  }
  if (draft.revision !== previous.revision + 1) {
    throw new ConcurrentPreflightUpdateError(draft.draftId, draft.revision - 1)
  }
  if (draft.executionIdempotencyKey !== previous.draft.executionIdempotencyKey) {
    throw new Error('Uma nova revisão não pode trocar a identidade da futura execução.')
  }
  if (canonicalJson(draft.client) !== canonicalJson(previous.draft.client) ||
      draft.correlationId !== previous.draft.correlationId) {
    throw new Error('Cliente e correlação precisam permanecer estáveis entre revisões.')
  }
  const previousAnswers = new Map(previous.draft.decisionAnswers.map((answer) => [String(answer.answerId), answer]))
  for (const answer of draft.decisionAnswers) {
    const inherited = previousAnswers.get(String(answer.answerId))
    if (inherited && canonicalJson(inherited) !== canonicalJson(answer)) {
      throw new Error(`A resposta herdada ${String(answer.answerId)} foi alterada.`)
    }
  }
  if ([...previousAnswers].some(([answerId]) => !draft.decisionAnswers.some((item) => item.answerId === answerId))) {
    throw new Error('Uma nova revisão não pode remover respostas já aplicadas.')
  }
  const newAnswers = draft.decisionAnswers.filter((answer) => !previousAnswers.has(String(answer.answerId)))
  const expectedDecisions = previous.report.status === 'decisions-required'
    ? previous.report.requiredDecisions
    : []
  const expectedIds = new Set(expectedDecisions.map((item) => String(item.decisionId)))
  const answeredIds = new Set(newAnswers.map((item) => String(item.decisionId)))
  if (expectedIds.size !== answeredIds.size || [...expectedIds].some((id) => !answeredIds.has(id))) {
    throw new Error('A nova revisão precisa responder exatamente todas as decisões do relatório anterior.')
  }
  if (newAnswers.some((answer) => object(answer.sourceReport).reportId !== previous.reportId)) {
    throw new Error('Resposta nova precisa apontar para o relatório imediatamente anterior.')
  }
}

function normalizeChecks(checks: ReadinessCheck[]): ReadinessCheck[] {
  const byId = new Map(checks.map((item) => [item.checkId, item]))
  if (checks.length !== CHECK_IDS.length || byId.size !== CHECK_IDS.length || CHECK_IDS.some((id) => !byId.has(id))) {
    throw new Error('Discovery precisa devolver exatamente os sete checks de prontidão.')
  }
  return CHECK_IDS.map((id) => byId.get(id) as ReadinessCheck)
}

function buildRequest(
  draft: TaskDraft,
  reportId: string,
  draftFingerprint: ReturnType<typeof fingerprint>,
  generatedAt: string,
  automaticDecisions: JsonObject[]
): TaskRequest {
  const hints = object(draft.executionHints)
  const priority = String(hints.priority ?? 'normal') as TaskRequest['priority']
  const expectedOutputKind = String(hints.expectedOutputKind)
  const criteria = draft.knownAcceptanceCriteria.map((criterion) => {
    const hint = criterion.verificationHint
    const method = typeof hint === 'string' ? hint : 'inspection'
    return {
      id: String(criterion.id),
      description: String(criterion.description),
      verification: {
        method: method as TaskRequest['acceptanceCriteria'][number]['verification']['method'],
        expected: String(criterion.description)
      }
    }
  })
  const request: TaskRequest = {
    contractVersion: '1.0',
    requestId: stableId('request', draft.executionIdempotencyKey),
    idempotencyKey: draft.executionIdempotencyKey,
    createdAt: generatedAt,
    preflight: {
      draftId: draft.draftId,
      draftRevision: draft.revision,
      draftFingerprint,
      readinessReportId: reportId
    },
    client: structuredClone(draft.client),
    objective: draft.objective,
    priority,
    context: structuredClone(draft.context),
    constraints: [
      ...structuredClone(draft.knownConstraints),
      ...automaticDecisions.map((decision) => ({
        id: stableId('constraint-automatic', String(decision.decisionId)),
        kind: 'policy',
        description: String(decision.decision).slice(0, 1000)
      }))
    ],
    authority: structuredClone(draft.availableExecutionAuthority),
    acceptanceCriteria: criteria,
    budget: structuredClone(draft.executionBudget.limits),
    expectedOutput: { kind: expectedOutputKind }
  }
  if (draft.correlationId !== undefined) request.correlationId = draft.correlationId
  return request
}

function buildDerivations(
  checks: ReadinessCheck[],
  applied: AppliedDecision[],
  automaticDecisions: JsonObject[]
): JsonObject[] {
  const answers = applied.map((item) => ({ kind: 'decision-answer', refId: String(item.answer.answerId) }))
  const automatic = automaticDecisions.map((item) => ({ kind: 'automatic-decision', refId: String(item.decisionId) }))
  const checkEvidence = (checkId: ReadinessCheckId): JsonObject[] => {
    const evidenceRef = checks.find((item) => item.checkId === checkId)?.evidenceRefs[0]
    return evidenceRef ? [{ kind: 'evidence', refId: evidenceRef }] : []
  }
  const item = (targetPointer: string, rationale: string, pointer: string, extra: JsonObject[] = []): JsonObject => ({
    targetPointer,
    rationale,
    sources: [{ kind: 'draft-field', pointer }, ...extra]
  })
  return [
    item('/idempotencyKey', 'A identidade executável foi fixada separadamente no draft.', '/executionIdempotencyKey'),
    item('/objective', 'O objetivo preserva a intenção declarada nesta revisão.', '/objective'),
    item('/priority', 'A prioridade vem do hint explícito ou do padrão normal.', '/executionHints/priority'),
    item('/context', 'O contexto preserva apenas referências e premissas do draft, incluindo respostas já aplicadas.', '/context', [
      ...answers,
      ...checkEvidence('context-resolvable')
    ]),
    item('/constraints', 'Todas as constraints conhecidas permanecem e decisões automáticas viram requisitos explícitos.', '/knownConstraints', automatic),
    item('/authority', 'A autoridade preparada é uma cópia sem expansão da autoridade disponível.', '/availableExecutionAuthority', checkEvidence('authority-sufficient')),
    item('/acceptanceCriteria', 'Os critérios conhecidos receberam um método de verificação explícito.', '/knownAcceptanceCriteria', checkEvidence('criteria-testable')),
    item('/budget', 'O request preserva exatamente os limites e a fonte controlada do draft.', '/executionBudget', checkEvidence('budget-feasible')),
    item('/expectedOutput', 'O tipo de saída vem do hint e incorpora requisitos reversíveis de preparação.', '/executionHints/expectedOutputKind', [
      ...checkEvidence('output-defined')
    ])
  ]
}

export class TaskPreflight {
  constructor(
    private readonly validator: ContractValidator,
    private readonly discovery: DiscoveryPort,
    private readonly store: PreflightStore,
    private readonly clock: PreflightClock = defaultClock
  ) {}

  async run(document: unknown): Promise<TaskReadinessReport> {
    this.validator.taskDraft(document)
    const draft = document
    const draftFingerprint = fingerprint(draft)
    const exact = await this.store.findPreflightRevision(draft.draftId, draft.revision)
    if (exact) {
      if (exact.draftFingerprint.value !== draftFingerprint.value) {
        throw new ConcurrentPreflightUpdateError(draft.draftId, draft.revision - 1)
      }
      this.validator.preflightReport(draft, exact.report)
      return exact.report
    }
    const latestForKey = await this.store.findLatestPreflightByIdempotencyKey(draft.idempotencyKey)
    if (latestForKey?.draftId !== undefined && latestForKey.draftId !== draft.draftId) {
      throw new DuplicatePreflightIntentError(latestForKey.draftId)
    }
    const previousRevision = draft.revision > 1
      ? await this.store.findPreflightRevision(draft.draftId, draft.revision - 1)
      : null
    assertRevisionContinuity(draft, previousRevision)
    const previousReports = await Promise.all(draft.decisionAnswers.map(async (answer) => {
      const reportId = String(object(answer.sourceReport).reportId)
      const report = await this.store.findPreflightReport(reportId)
      if (!report) throw new Error(`Relatório anterior ${reportId} não foi encontrado no Preflight Store.`)
      return report
    }))
    const applied = resolveAnswers(draft, previousReports, this.validator)
    const generatedAt = this.clock.now().toISOString()
    const reportId = stableId('readiness', `${draft.draftId}:${draft.revision}:${draftFingerprint.value}`)
    const assessment = await this.discovery.inspect({
      draft,
      profile: profileFor(draft),
      generatedAt,
      appliedDecisions: applied
    })
    const readinessChecks = normalizeChecks(assessment.readinessChecks)
    const failed = readinessChecks.some((item) => item.status === 'failed')
    const needsDecision = readinessChecks.some((item) => item.status === 'needs-decision')
    if (failed && (needsDecision || assessment.requiredDecisions.length > 0)) {
      throw new Error('Discovery misturou impossibilidade comprovada com decisão pendente.')
    }
    if (failed && !assessment.failure) throw new Error('Discovery marcou falha sem causa comprovada.')
    if (needsDecision && assessment.requiredDecisions.length === 0) {
      throw new Error('Discovery marcou decisão pendente sem devolver suas opções.')
    }

    const status: TaskReadinessReport['status'] = failed
      ? 'not-feasible'
      : needsDecision
        ? 'decisions-required'
        : 'ready'
    const report: TaskReadinessReport = {
      contractVersion: '1.0',
      reportId,
      draftId: draft.draftId,
      draftRevision: draft.revision,
      draftFingerprint,
      generatedAt,
      status,
      readinessChecks,
      automaticDecisions: assessment.automaticDecisions,
      requiredDecisions: status === 'decisions-required' ? assessment.requiredDecisions : [],
      appliedDecisionAnswers: applied.map((item) => ({
        answerId: String(item.answer.answerId),
        decisionId: String(item.answer.decisionId),
        sourceReportId: item.sourceReport.reportId
      })),
      evidence: assessment.evidence
    }
    if (status === 'not-feasible') {
      if (!assessment.failure) throw new Error('Discovery marcou falha sem causa comprovada.')
      report.failure = assessment.failure
    }
    if (status === 'ready') {
      const preparedRequest = buildRequest(
        draft,
        reportId,
        draftFingerprint,
        generatedAt,
        assessment.automaticDecisions
      )
      report.preparedRequest = preparedRequest
      report.preparedRequestFingerprint = fingerprint(preparedRequest)
      report.requestDerivations = buildDerivations(
        readinessChecks,
        applied,
        assessment.automaticDecisions
      )
    }
    this.validator.preflightReport(draft, report)
    const stored = await this.store.appendPreflightRevision({
      draftId: draft.draftId,
      revision: draft.revision,
      idempotencyKey: draft.idempotencyKey,
      draftFingerprint,
      draft,
      reportId,
      reportFingerprint: fingerprint(report),
      report,
      createdAt: generatedAt
    }, draft.revision - 1)
    this.validator.preflightReport(draft, stored.report)
    return stored.report
  }
}
