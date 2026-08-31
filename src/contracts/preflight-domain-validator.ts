import { canonicalJson, fingerprint } from '../domain/fingerprint.js'
import type { JsonObject, TaskDraft, TaskReadinessReport, TaskRequest } from '../domain/types.js'

export class PreflightDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PreflightDomainError'
  }
}

function fail(code: string, message: string): never {
  throw new PreflightDomainError(code, message)
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function assertUnique(items: JsonObject[], field: string, code: string): void {
  const values = items.map((item) => String(item[field]))
  if (new Set(values).size !== values.length) fail(code, `${field} precisa ser único.`)
}

function derivations(report: TaskReadinessReport): JsonObject[] {
  return objects(report.requestDerivations)
}

function derivation(report: TaskReadinessReport, pointer: string): JsonObject | undefined {
  return derivations(report).find((item) => item.targetPointer === pointer)
}

function hasMaterialSource(item: JsonObject | undefined): boolean {
  return objects(item?.sources).some((source) => source.kind !== 'draft-field')
}

function authorityByResource(authority: JsonObject): Map<string, Set<string>> {
  return new Map(objects(authority.grants).map((grant) => [
    String(grant.resourceRef),
    new Set(strings(grant.operations))
  ]))
}

function assertEvidenceGraph(draft: TaskDraft, report: TaskReadinessReport): void {
  const evidence = objects(report.evidence)
  const required = objects(report.requiredDecisions)
  const automatic = objects(report.automaticDecisions)
  assertUnique(evidence, 'evidenceId', 'preflight-duplicate-evidence')
  assertUnique(required, 'decisionId', 'preflight-duplicate-decision')
  assertUnique(automatic, 'decisionId', 'preflight-duplicate-decision')
  const allDecisionIds = [...required, ...automatic].map((item) => String(item.decisionId))
  if (new Set(allDecisionIds).size !== allDecisionIds.length) {
    fail('preflight-duplicate-decision', 'decisionId precisa ser único entre decisões automáticas e requeridas.')
  }
  const evidenceIds = new Set(evidence.map((item) => String(item.evidenceId)))
  const requiredIds = new Set(required.map((item) => String(item.decisionId)))
  const referenceIds = new Set(draft.context.references.map((item) => item.refId))
  for (const item of evidence) {
    if (strings(item.sourceRefs).some((ref) => !referenceIds.has(ref))) {
      fail('preflight-evidence-source-missing', 'Evidência aponta para referência que não pertence ao draft.')
    }
  }
  for (const item of report.readinessChecks) {
    if (item.evidenceRefs.some((ref) => !evidenceIds.has(ref))) {
      fail('preflight-check-evidence-missing', `Check ${item.checkId} aponta para evidência inexistente.`)
    }
    if (item.decisionRefs.some((ref) => !requiredIds.has(ref))) {
      fail('preflight-check-decision-missing', `Check ${item.checkId} aponta para decisão inexistente.`)
    }
  }
  for (const item of [...required, ...automatic]) {
    if (strings(item.evidenceRefs).some((ref) => !evidenceIds.has(ref))) {
      fail('preflight-decision-evidence-missing', 'Decisão aponta para evidência inexistente.')
    }
  }
  for (const item of required) {
    const optionIds = new Set(objects(item.options).map((option) => String(option.optionId)))
    if (!optionIds.has(String(item.recommendedOptionId))) {
      fail('preflight-recommendation-missing', 'A recomendação precisa apontar para uma opção existente.')
    }
  }
}

function assertReadyDerivation(draft: TaskDraft, report: TaskReadinessReport, request: TaskRequest): void {
  const draftAuthority = draft.availableExecutionAuthority
  const requestAuthority = request.authority
  const available = authorityByResource(draftAuthority)
  for (const grant of requestAuthority.grants) {
    const operations = available.get(grant.resourceRef)
    if (!operations || grant.operations.some((operation) => !operations.has(operation))) {
      fail('preflight-authority-operation-expanded', 'O request preparou recurso ou operação fora da autoridade disponível.')
    }
  }

  if (!same(request.client, draft.client)) {
    fail('preflight-client-mismatch', 'O cliente do request preparado diverge do draft.')
  }

  const draftRefs = new Map(draft.context.references.map((item) => [item.refId, canonicalJson(item)]))
  const contextExpanded = request.context.references.some((item) => draftRefs.get(item.refId) !== canonicalJson(item))
  const draftAssumptions = new Map(draft.context.assumptions.map((item) => [String(item.id), canonicalJson(item)]))
  const assumptionExpanded = request.context.assumptions.some((item) => draftAssumptions.get(String(item.id)) !== canonicalJson(item))
  if (contextExpanded || assumptionExpanded) {
    fail('preflight-context-expanded', 'O request ganhou contexto que não estava no draft.')
  }

  const requestBoundaries = new Set(request.authority.expansionBoundaries)
  if (draft.availableExecutionAuthority.expansionBoundaries.some((item) => !requestBoundaries.has(item))) {
    fail('preflight-boundary-removed', 'O request removeu uma barreira de expansão.')
  }

  const budget = request.budget as Record<string, number>
  const limits = draft.executionBudget.limits as Record<string, number>
  if (Object.keys(budget).some((key) => !(key in limits)) || Object.entries(budget).some(([key, value]) => value > Number(limits[key]))) {
    fail('preflight-budget-expanded', 'O request criou ou ampliou uma métrica de orçamento.')
  }

  const preflight = object(request.preflight)
  if (preflight.readinessReportId !== report.reportId) {
    fail('preflight-report-mismatch', 'O request preparado aponta para outro relatório.')
  }
  if (preflight.draftId !== draft.draftId || preflight.draftRevision !== draft.revision || !same(preflight.draftFingerprint, report.draftFingerprint)) {
    fail('preflight-draft-binding-mismatch', 'O request preparado aponta para outra revisão do draft.')
  }

  if (request.idempotencyKey !== draft.executionIdempotencyKey) {
    fail('preflight-execution-idempotency-mismatch', 'A identidade de execução mudou durante o Preflight.')
  }

  const objectiveDerivation = derivation(report, '/objective')
  if (request.objective !== draft.objective && !hasMaterialSource(objectiveDerivation)) {
    fail('preflight-objective-untraced', 'O objetivo mudou sem resposta, decisão automática ou evidência material.')
  }

  const requestConstraints = new Map(request.constraints.map((item) => [String(item.id), canonicalJson(item)]))
  if (draft.knownConstraints.some((item) => requestConstraints.get(String(item.id)) !== canonicalJson(item))) {
    fail('preflight-known-constraint-removed', 'Uma constraint conhecida foi removida ou alterada.')
  }

  const criterionIds = new Set(request.acceptanceCriteria.map((item) => item.id))
  if (draft.knownAcceptanceCriteria.some((item) => !criterionIds.has(String(item.id)))) {
    fail('preflight-known-criterion-removed', 'Um critério conhecido foi removido.')
  }

  const hintedPriority = String(object(draft.executionHints).priority ?? 'normal')
  if (request.priority !== hintedPriority && !hasMaterialSource(derivation(report, '/priority'))) {
    fail('preflight-priority-mismatch', 'A prioridade mudou sem fonte material.')
  }
  const hintedOutput = object(draft.executionHints).expectedOutputKind
  if (typeof hintedOutput === 'string' && request.expectedOutput.kind !== hintedOutput) {
    fail('preflight-output-kind-mismatch', 'O tipo de saída diverge do hint explícito desta revisão.')
  }

  const materialFields = [
    '/idempotencyKey',
    '/objective',
    '/priority',
    '/context',
    '/constraints',
    '/authority',
    '/acceptanceCriteria',
    '/budget',
    '/expectedOutput'
  ]
  const targetPointers = derivations(report).map((item) => String(item.targetPointer))
  if (new Set(targetPointers).size !== targetPointers.length || materialFields.some((pointer) => !targetPointers.includes(pointer))) {
    fail('preflight-derivation-incomplete', 'Todo campo material precisa de uma derivação única.')
  }

  const evidenceIds = new Set(objects(report.evidence).map((item) => String(item.evidenceId)))
  const answerIds = new Set(draft.decisionAnswers.map((item) => String(item.answerId)))
  const automaticIds = new Set(objects(report.automaticDecisions).map((item) => String(item.decisionId)))
  for (const item of derivations(report)) {
    for (const source of objects(item.sources)) {
      if (source.kind === 'decision-answer' && !answerIds.has(String(source.refId))) {
        fail('preflight-derivation-answer-missing', 'Derivação aponta para resposta inexistente.')
      }
      if (source.kind === 'automatic-decision' && !automaticIds.has(String(source.refId))) {
        fail('preflight-derivation-decision-missing', 'Derivação aponta para decisão automática inexistente.')
      }
      if (source.kind === 'evidence' && !evidenceIds.has(String(source.refId))) {
        fail('preflight-derivation-evidence-missing', 'Derivação aponta para evidência inexistente.')
      }
    }
  }
  const usedAutomatic = new Set(derivations(report).flatMap((item) => objects(item.sources))
    .filter((source) => source.kind === 'automatic-decision')
    .map((source) => String(source.refId)))
  if ([...automaticIds].some((id) => !usedAutomatic.has(id))) {
    fail('preflight-automatic-decision-orphaned', 'Toda decisão automática precisa derivar ao menos um campo do request.')
  }

  const applied = objects(report.appliedDecisionAnswers)
  const appliedById = new Map(applied.map((item) => [String(item.answerId), item]))
  if (applied.length !== draft.decisionAnswers.length || draft.decisionAnswers.some((answer) => {
    const item = appliedById.get(String(answer.answerId))
    return !item || item.decisionId !== answer.decisionId || item.sourceReportId !== object(answer.sourceReport).reportId
  })) {
    fail('preflight-answer-not-applied', 'Toda resposta do draft precisa aparecer exatamente uma vez no relatório ready.')
  }

  if (draft.correlationId !== request.correlationId) {
    fail('preflight-correlation-mismatch', 'O correlationId mudou durante o Preflight.')
  }
  const draftExpiry = draft.availableExecutionAuthority.expiresAt
  const requestExpiry = request.authority.expiresAt
  if ((draftExpiry === undefined && requestExpiry !== undefined) ||
      (draftExpiry !== undefined && requestExpiry !== undefined && Date.parse(requestExpiry) > Date.parse(draftExpiry))) {
    fail('preflight-authority-expiry-expanded', 'O request prolongou a validade da autoridade.')
  }

  if (!same(report.preparedRequestFingerprint, fingerprint(request))) {
    fail('preflight-request-fingerprint-mismatch', 'O fingerprint do request preparado não corresponde ao conteúdo.')
  }
}

export function assertPreflightDomain(draft: TaskDraft, report: TaskReadinessReport): void {
  if (report.draftId !== draft.draftId || report.draftRevision !== draft.revision) {
    fail('preflight-draft-mismatch', 'O relatório não pertence à revisão recebida.')
  }
  if (!same(report.draftFingerprint, fingerprint(draft))) {
    fail('preflight-draft-fingerprint-mismatch', 'O fingerprint do draft não corresponde ao documento.')
  }
  assertEvidenceGraph(draft, report)
  if (report.status === 'ready') {
    if (!report.preparedRequest || !report.preparedRequestFingerprint) {
      fail('preflight-ready-without-request', 'Relatório ready precisa conter request e fingerprint.')
    }
    assertReadyDerivation(draft, report, report.preparedRequest)
  }
}
