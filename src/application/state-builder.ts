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
  ledger(next).planRefs = [{
    planId: binding.planId,
    planRevision: binding.planRevision,
    planFingerprint: binding.planFingerprint,
    strategyFingerprint: binding.strategyFingerprint,
    basisStateRevision: binding.basisStateRevision,
    activatedAtRevision: next.stateRevision,
    activationTransitionId: next.lifecycle.lastTransitionId,
    activatedAt: now,
    authorizationBinding
  }]
  return next
}

export function startAttempt(previous: TaskState, planId: string, planRevision: number, strategyFingerprint: Fingerprint, now: string): TaskState {
  const attemptId = stableId('attempt', `${previous.taskId}:${previous.executionEpoch}:1`)
  const next = transition(previous, 'running', 'execution-started', now, attemptId)
  next.activeAttemptId = attemptId
  next.usage = { attemptCount: 1, maxParallelismObserved: 1, activeDurationMs: 0 }
  ledger(next).attempts = [{
    attemptId,
    ordinal: 1,
    status: 'active',
    planRef: { planId, planRevision },
    strategyFingerprint,
    executionEpoch: next.executionEpoch,
    startedAt: now,
    lastUpdatedRevision: next.stateRevision,
    effectRefs: [],
    evidenceRefs: []
  }]
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
  ledger(next).resultRefs = [{
    resultId,
    stateRevision: next.stateRevision,
    transitionId: next.lifecycle.lastTransitionId,
    emissionSequence: 1,
    status: 'succeeded',
    resultFingerprint,
    emittedAt: now
  }]
  return next
}
