import type { Fingerprint, JsonObject, TaskRequest, TaskState, TaskStatus } from '../domain/types.js'
import { stableId } from '../domain/fingerprint.js'

interface AuthorizationBinding {
  enforcementId: string
  enforcementFingerprint: Fingerprint
  decisionId: string
  decisionFingerprint: Fingerprint
  expiresAt: string
  activatedAtRevision: number
}

export interface TaskBlockSpecification {
  blockId: string
  resultId: string
  evidenceId: string
  resumeTarget: 'planning' | 'ready' | 'verifying'
  mode: 'resume-same-request' | 'replacement-request-required'
  condition: string
}

interface PlanBinding {
  planId: string
  planRevision: number
  planFingerprint: Fingerprint
  strategyFingerprint: Fingerprint
  basisStateRevision: number
  authorization: AuthorizationBinding
}

function ledger(state: TaskState): JsonObject {
  return state.ledger
}

function arrayAt(value: JsonObject, key: string): JsonObject[] {
  const found = value[key]
  if (!Array.isArray(found)) throw new Error(`Ledger sem ${key}.`)
  return found as JsonObject[]
}

export function acceptedState(
  taskId: string,
  request: TaskRequest,
  requestFingerprint: Fingerprint,
  now: string
): TaskState {
  const transitionId = stableId('transition-accepted', `${taskId}:1`)
  return {
    modelVersion: '1.0',
    taskId,
    requestBinding: { requestId: request.requestId, requestFingerprint },
    acceptedAt: now,
    updatedAt: now,
    stateRevision: 1,
    executionEpoch: 1,
    lifecycle: { state: 'accepted', enteredAt: now, lastTransitionId: transitionId },
    criterionProgress: request.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: 'not-run',
      evidenceRefs: []
    })),
    usage: { attemptCount: 0, maxParallelismObserved: 0, activeDurationMs: 0 },
    ledger: {
      transitions: [{
        transitionId,
        sequence: 1,
        stateRevision: 1,
        from: null,
        to: 'accepted',
        at: now,
        triggerKind: 'admission',
        triggerRef: request.requestId,
        evidenceRefs: []
      }],
      attempts: [],
      effects: [],
      blocks: [],
      checkpoints: [],
      evidenceRefs: [],
      artifactRefs: [],
      resultRefs: []
    }
  }
}

export function transition(
  previous: TaskState,
  to: TaskStatus,
  triggerKind: string,
  now: string,
  triggerRef?: string
): TaskState {
  const next = structuredClone(previous)
  const from = previous.lifecycle.state
  const revision = previous.stateRevision + 1
  const transitionId = stableId(`transition-${to}`, `${previous.taskId}:${revision}:${triggerKind}`)
  next.stateRevision = revision
  next.updatedAt = now
  next.lifecycle = { state: to, enteredAt: now, lastTransitionId: transitionId }
  const transitions = arrayAt(ledger(next), 'transitions')
  const entry: JsonObject = {
    transitionId,
    sequence: transitions.length + 1,
    stateRevision: revision,
    from,
    to,
    at: now,
    triggerKind,
    evidenceRefs: []
  }
  if (triggerRef) entry.triggerRef = triggerRef
  transitions.push(entry)
  return next
}

export function bindReadyState(previous: TaskState, binding: PlanBinding, now: string): TaskState {
  const next = transition(previous, 'ready', 'planning-completed', now, binding.planId)
  const authorizationBinding: JsonObject = {
    enforcementId: binding.authorization.enforcementId,
    enforcementFingerprint: binding.authorization.enforcementFingerprint,
    decisionId: binding.authorization.decisionId,
    decisionFingerprint: binding.authorization.decisionFingerprint,
    expiresAt: binding.authorization.expiresAt,
    activatedAtRevision: next.stateRevision
  }
  next.activePlanBinding = {
    planId: binding.planId,
    planRevision: binding.planRevision,
    planFingerprint: binding.planFingerprint,
    strategyFingerprint: binding.strategyFingerprint,
    activatedAtRevision: next.stateRevision,
    authorizationBinding
  }
  const rawPlanRefs = ledger(next).planRefs
  const planRefs = Array.isArray(rawPlanRefs) ? rawPlanRefs as JsonObject[] : []
  ledger(next).planRefs = planRefs
  planRefs.push({
    planId: binding.planId,
    planRevision: binding.planRevision,
    planFingerprint: binding.planFingerprint,
    strategyFingerprint: binding.strategyFingerprint,
    basisStateRevision: binding.basisStateRevision,
    activatedAtRevision: next.stateRevision,
    activationTransitionId: next.lifecycle.lastTransitionId,
    activatedAt: now,
    authorizationBinding
  })
  return next
}

export function refreshReadyAuthorization(
  previous: TaskState,
  authorization: AuthorizationBinding,
  now: string
): TaskState {
  if (previous.lifecycle.state !== 'ready') throw new Error('Somente tarefa ready pode renovar autorização.')
  const active = previous.activePlanBinding
  if (!active || typeof active !== 'object' || Array.isArray(active)) throw new Error('Plano ativo ausente na renovação.')
  const activeBinding = active as JsonObject
  const next = transition(previous, 'ready', 'authorization-refreshed', now, authorization.enforcementId)
  const authorizationBinding: JsonObject = {
    enforcementId: authorization.enforcementId,
    enforcementFingerprint: authorization.enforcementFingerprint,
    decisionId: authorization.decisionId,
    decisionFingerprint: authorization.decisionFingerprint,
    expiresAt: authorization.expiresAt,
    activatedAtRevision: next.stateRevision
  }
  next.activePlanBinding = { ...activeBinding, authorizationBinding }
  const planRefs = arrayAt(ledger(next), 'planRefs')
  const activePlanRef = [...planRefs].reverse().find((item) =>
    item.planId === activeBinding.planId && item.planRevision === activeBinding.planRevision
  )
  if (!activePlanRef) throw new Error('Histórico do plano ativo ausente na renovação.')
  activePlanRef.authorizationBinding = authorizationBinding
  return next
}

export function blockTaskState(previous: TaskState, specification: TaskBlockSpecification, now: string): TaskState {
  const from = previous.lifecycle.state
  if (from !== 'planning' && from !== 'ready') {
    throw new Error(`Bloqueio v1 ainda não suporta origem ${from}.`)
  }
  const next = transition(previous, 'blocked', 'block-detected', now, specification.blockId)
  next.activeBlockRef = specification.blockId
  const transitions = arrayAt(ledger(next), 'transitions')
  const lastTransition = transitions.at(-1)
  if (!lastTransition) throw new Error('Transição de bloqueio ausente.')
  lastTransition.resultRef = specification.resultId
  lastTransition.evidenceRefs = [specification.evidenceId]
  arrayAt(ledger(next), 'blocks').push({
    blockId: specification.blockId,
    blockingResultId: specification.resultId,
    blockedAtRevision: next.stateRevision,
    blockedFrom: from,
    resumeTarget: specification.resumeTarget,
    mode: specification.mode,
    condition: specification.condition,
    evidenceRefs: [specification.evidenceId],
    createdAt: now
  })
  const rawEvidenceRefs = ledger(next).evidenceRefs
  if (!Array.isArray(rawEvidenceRefs)) throw new Error('Ledger sem evidenceRefs.')
  if (!rawEvidenceRefs.some((item) => item === specification.evidenceId)) rawEvidenceRefs.push(specification.evidenceId)
  return next
}

export function attachResultReference(
  previous: TaskState,
  resultId: string,
  resultFingerprint: Fingerprint,
  status: 'blocked' | 'succeeded' | 'failed' | 'cancelled',
  emittedAt: string
): TaskState {
  const next = structuredClone(previous)
  const resultRefs = arrayAt(ledger(next), 'resultRefs')
  resultRefs.push({
    resultId,
    stateRevision: next.stateRevision,
    transitionId: next.lifecycle.lastTransitionId,
    emissionSequence: resultRefs.length + 1,
    status,
    resultFingerprint,
    emittedAt
  })
  return next
}

export function resumeBlockedState(previous: TaskState, now: string): TaskState {
  if (previous.lifecycle.state !== 'blocked' || typeof previous.activeBlockRef !== 'string') {
    throw new Error('A tarefa não possui bloqueio ativo para retomar.')
  }
  const blocks = arrayAt(ledger(previous), 'blocks')
  const active = blocks.find((item) => item.blockId === previous.activeBlockRef)
  if (!active) throw new Error('Registro do bloqueio ativo não foi encontrado.')
  if (active.mode !== 'resume-same-request') {
    throw new Error('O bloqueio exige um novo TaskRequest e não pode retomar a tarefa atual.')
  }
  const target = active.resumeTarget
  if (target !== 'planning' && target !== 'ready' && target !== 'verifying') {
    throw new Error('Destino de retomada inválido.')
  }
  const next = transition(previous, target, 'condition-restored', now, String(active.blockId))
  delete next.activeBlockRef
  if (target === 'planning') delete next.activePlanBinding
  return next
}

export function startAttempt(previous: TaskState, planId: string, planRevision: number, strategyFingerprint: Fingerprint, now: string): TaskState {
  const attempts = arrayAt(ledger(previous), 'attempts')
  const ordinal = attempts.length + 1
  const attemptId = stableId('attempt', `${previous.taskId}:${previous.executionEpoch}:${ordinal}`)
  const next = transition(previous, 'running', 'execution-started', now, attemptId)
  next.activeAttemptId = attemptId
  next.usage = {
    ...next.usage,
    attemptCount: ordinal,
    maxParallelismObserved: Math.max(1, Number(next.usage.maxParallelismObserved ?? 0))
  }
  arrayAt(ledger(next), 'attempts').push({
    attemptId,
    ordinal,
    status: 'active',
    planRef: { planId, planRevision },
    strategyFingerprint,
    executionEpoch: next.executionEpoch,
    startedAt: now,
    lastUpdatedRevision: next.stateRevision,
    effectRefs: [],
    evidenceRefs: []
  })
  return next
}

export function scheduleRetry(
  previous: TaskState,
  failureEvidenceRef: string,
  now: string
): TaskState {
  if (previous.lifecycle.state !== 'running' && previous.lifecycle.state !== 'verifying') {
    throw new Error(`Retry nao pode ser agendado a partir de ${previous.lifecycle.state}.`)
  }
  const attemptId = previous.activeAttemptId
  if (typeof attemptId !== 'string') throw new Error('Retry sem tentativa ativa.')
  const next = transition(previous, 'planning', 'retry-scheduled', now, attemptId)
  const attempts = arrayAt(ledger(next), 'attempts')
  const attempt = attempts.find((item) => item.attemptId === attemptId)
  if (!attempt) throw new Error('Tentativa ativa nao foi encontrada para o retry.')
  attempt.status = 'failed'
  attempt.endedAt = now
  attempt.lastUpdatedRevision = next.stateRevision
  attempt.evidenceRefs = [...new Set([
    ...(Array.isArray(attempt.evidenceRefs) ? attempt.evidenceRefs.map(String) : []),
    failureEvidenceRef
  ])]
  const evidenceRefs = ledger(next).evidenceRefs
  if (!Array.isArray(evidenceRefs)) throw new Error('Ledger sem evidenceRefs.')
  if (!evidenceRefs.includes(failureEvidenceRef)) evidenceRefs.push(failureEvidenceRef)
  const lastTransition = arrayAt(ledger(next), 'transitions').at(-1)
  if (!lastTransition) throw new Error('Transicao de retry ausente.')
  lastTransition.evidenceRefs = [failureEvidenceRef]
  next.executionEpoch = previous.executionEpoch + 1
  next.usage = {
    ...next.usage,
    activeDurationMs: Number(next.usage.activeDurationMs ?? 0)
      + Math.max(0, Date.parse(now) - Date.parse(String(attempt.startedAt)))
  }
  delete next.activeAttemptId
  delete next.activeStepRunRef
  delete next.activePlanBinding
  return next
}

/** Persist intent first; the worker reconciles in-flight effects before settling. */
export function requestCancellation(
  previous: TaskState,
  evidenceRef: string,
  initiatedBy: 'client' | 'policy' | 'runtime' | 'deadline',
  now: string
): TaskState {
  if (!['accepted', 'planning', 'ready', 'blocked', 'running', 'verifying'].includes(previous.lifecycle.state)) {
    throw new Error(`Cancelamento não pode ser solicitado a partir de ${previous.lifecycle.state}.`)
  }
  const cancellationId = stableId('cancellation', `${previous.taskId}:${previous.stateRevision}:${initiatedBy}`)
  const requested = transition(previous, 'cancelling', 'cancellation-requested', now, cancellationId)
  requested.executionEpoch = previous.executionEpoch + 1
  const cancellation: JsonObject = {
    cancellationId,
    initiatedBy,
    requestedAt: now,
    status: 'requested',
    lastUpdatedRevision: requested.stateRevision,
    evidenceRefs: [evidenceRef]
  }
  requested.cancellation = cancellation
  delete requested.activeBlockRef
  return requested
}

export function markCancellationQuiesced(previous: TaskState, evidenceRefs: string[], artifactRefs: string[], now: string): TaskState {
  if (previous.lifecycle.state !== 'cancelling') throw new Error('Tarefa não está cancelando.')
  const next = structuredClone(previous)
  next.stateRevision += 1
  next.updatedAt = now
  next.cancellation = { ...(next.cancellation as JsonObject), status: 'quiesced', lastUpdatedRevision: next.stateRevision, evidenceRefs }
  for (const key of ['attempts', 'stepRuns']) {
    for (const item of (Array.isArray(next.ledger[key]) ? next.ledger[key] : []) as JsonObject[]) {
      if (['active', 'awaiting-verification', 'suspended'].includes(String(item.status))) {
        item.status = 'cancelled'
        item.endedAt = now
        item.lastUpdatedRevision = next.stateRevision
        item.evidenceRefs = [...new Set([...(Array.isArray(item.evidenceRefs) ? item.evidenceRefs.map(String) : []), ...evidenceRefs])]
      }
    }
  }
  delete next.activeAttemptId
  next.ledger.evidenceRefs = [...new Set([...(next.ledger.evidenceRefs as string[]), ...evidenceRefs])]
  next.ledger.artifactRefs = [...new Set([...(next.ledger.artifactRefs as string[]), ...artifactRefs])]
  return next
}

export function settleCancellation(
  previous: TaskState,
  resultId: string,
  resultFingerprint: Fingerprint,
  evidenceRef: string,
  now: string
): TaskState {
  if (previous.lifecycle.state !== 'cancelling' || !previous.cancellation || typeof previous.cancellation !== 'object' || Array.isArray(previous.cancellation)) {
    throw new Error('Cancelamento pendente não foi encontrado para estabilização.')
  }
  const cancellation = previous.cancellation as JsonObject
  if (cancellation.status !== 'quiesced') throw new Error('Cancelamento exige quiescência persistida antes do resultado.')
  const next = transition(previous, 'cancelled', 'cancellation-settled', now, String(cancellation.cancellationId))
  next.cancellation = {
    ...cancellation,
    status: 'quiesced',
    lastUpdatedRevision: next.stateRevision
  }
  const rawEvidenceRefs = ledger(next).evidenceRefs
  if (!Array.isArray(rawEvidenceRefs)) throw new Error('Ledger sem evidenceRefs.')
  const evidenceRefs = rawEvidenceRefs as string[]
  if (!evidenceRefs.includes(evidenceRef)) evidenceRefs.push(evidenceRef)
  const lastTransition = arrayAt(ledger(next), 'transitions').at(-1)
  if (!lastTransition) throw new Error('Transição de cancelamento ausente.')
  lastTransition.resultRef = resultId
  lastTransition.evidenceRefs = [evidenceRef]
  next.criterionProgress = next.criterionProgress.map((criterion) => ({
    criterionId: String(criterion.criterionId), status: 'not-run', evidenceRefs: []
  }))
  next.terminalResultRef = resultId
  const resultRefs = arrayAt(ledger(next), 'resultRefs')
  resultRefs.push({
    resultId,
    stateRevision: next.stateRevision,
    transitionId: next.lifecycle.lastTransitionId,
    emissionSequence: resultRefs.length + 1,
    status: 'cancelled',
    resultFingerprint,
    emittedAt: now
  })
  return next
}

export function failTask(
  previous: TaskState,
  resultId: string,
  resultFingerprint: Fingerprint,
  evidenceRef: string,
  now: string
): TaskState {
  if (previous.lifecycle.state !== 'running' && previous.lifecycle.state !== 'verifying') {
    throw new Error(`Falha terminal nao pode ser registrada a partir de ${previous.lifecycle.state}.`)
  }
  const attemptId = previous.activeAttemptId
  if (typeof attemptId !== 'string') throw new Error('Falha terminal sem tentativa ativa.')
  const next = transition(previous, 'failed', 'recovery-exhausted', now, attemptId)
  const attempts = arrayAt(ledger(next), 'attempts')
  const attempt = attempts.find((item) => item.attemptId === attemptId)
  if (!attempt) throw new Error('Tentativa ativa nao foi encontrada na falha terminal.')
  attempt.status = 'failed'
  attempt.endedAt = now
  attempt.lastUpdatedRevision = next.stateRevision
  attempt.evidenceRefs = [...new Set([
    ...(Array.isArray(attempt.evidenceRefs) ? attempt.evidenceRefs.map(String) : []),
    evidenceRef
  ])]
  const evidenceRefs = ledger(next).evidenceRefs
  if (!Array.isArray(evidenceRefs)) throw new Error('Ledger sem evidenceRefs.')
  if (!evidenceRefs.includes(evidenceRef)) evidenceRefs.push(evidenceRef)
  const lastTransition = arrayAt(ledger(next), 'transitions').at(-1)
  if (!lastTransition) throw new Error('Transicao terminal ausente.')
  lastTransition.resultRef = resultId
  lastTransition.evidenceRefs = [evidenceRef]
  next.criterionProgress = next.criterionProgress.map((criterion, index) => ({
    criterionId: String(criterion.criterionId),
    status: index === 0 ? 'failed' : 'not-run',
    evidenceRefs: index === 0 ? [evidenceRef] : []
  }))
  delete next.activeAttemptId
  delete next.activeStepRunRef
  next.terminalResultRef = resultId
  next.usage = {
    ...next.usage,
    activeDurationMs: Number(next.usage.activeDurationMs ?? 0)
      + Math.max(0, Date.parse(now) - Date.parse(String(attempt.startedAt)))
  }
  const resultRefs = arrayAt(ledger(next), 'resultRefs')
  resultRefs.push({
    resultId,
    stateRevision: next.stateRevision,
    transitionId: next.lifecycle.lastTransitionId,
    emissionSequence: resultRefs.length + 1,
    status: 'failed',
    resultFingerprint,
    emittedAt: now
  })
  return next
}

export function beginVerification(
  previous: TaskState,
  evidenceRefs: string[],
  now: string,
  runtimeBinding?: JsonObject
): TaskState {
  const attemptId = previous.activeAttemptId
  if (typeof attemptId !== 'string') throw new Error('Verificação sem tentativa ativa.')
  const next = transition(previous, 'verifying', 'verification-started', now, attemptId)
  ledger(next).evidenceRefs = evidenceRefs
  if (runtimeBinding) {
    const attempts = arrayAt(ledger(next), 'attempts')
    const attempt = attempts.find((item) => item.attemptId === attemptId)
    if (!attempt) throw new Error('Tentativa não encontrada para registrar o Agent Runtime.')
    attempt.runtimeBinding = runtimeBinding
    const inputTokens = Number(runtimeBinding.inputTokens ?? 0)
    const outputTokens = Number(runtimeBinding.outputTokens ?? 0)
    next.usage = {
      ...next.usage,
      tokens: inputTokens + outputTokens,
      costUsd: Number(runtimeBinding.estimatedCostUsd ?? 0)
    }
  }
  return next
}

export function succeed(
  previous: TaskState,
  resultId: string,
  evidenceByCriterion: Map<string, string[]>,
  resultFingerprint: Fingerprint,
  now: string
): TaskState {
  const attemptId = previous.activeAttemptId
  if (typeof attemptId !== 'string') throw new Error('Conclusão sem tentativa ativa.')
  const next = transition(previous, 'succeeded', 'verification-passed', now, attemptId)
  const lastTransition = arrayAt(ledger(next), 'transitions').at(-1)
  if (!lastTransition) throw new Error('Transição terminal ausente.')
  lastTransition.resultRef = resultId
  const existingEvidence = ledger(next).evidenceRefs
  const allEvidence = [...new Set([
    ...(Array.isArray(existingEvidence) ? existingEvidence.map(String) : []),
    ...[...evidenceByCriterion.values()].flat()
  ])]
  lastTransition.evidenceRefs = allEvidence
  next.criterionProgress = next.criterionProgress.map((criterion) => {
    const criterionId = String(criterion.criterionId)
    return { criterionId, status: 'passed', evidenceRefs: evidenceByCriterion.get(criterionId) ?? [] }
  })
  const attempts = arrayAt(ledger(next), 'attempts')
  const attempt = attempts.find((item) => item.attemptId === attemptId)
  if (!attempt) throw new Error('Tentativa não encontrada no ledger.')
  attempt.status = 'completed'
  attempt.endedAt = now
  attempt.lastUpdatedRevision = next.stateRevision
  attempt.evidenceRefs = allEvidence
  delete next.activeAttemptId
  delete next.activeStepRunRef
  next.terminalResultRef = resultId
  next.usage = { ...next.usage, activeDurationMs: Math.max(0, Date.parse(now) - Date.parse(String(attempt.startedAt))) }
  ledger(next).evidenceRefs = allEvidence
  const resultRefs = arrayAt(ledger(next), 'resultRefs')
  resultRefs.push({
    resultId,
    stateRevision: next.stateRevision,
    transitionId: next.lifecycle.lastTransitionId,
    emissionSequence: resultRefs.length + 1,
    status: 'succeeded',
    resultFingerprint,
    emittedAt: now
  })
  return next
}
