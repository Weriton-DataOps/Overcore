import { fingerprint, stableId } from '../domain/fingerprint.js'
import type { Fingerprint, JsonObject, TaskRequest } from '../domain/types.js'

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`)
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} inválido.`)
  return value
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} inválido.`)
  return value
}

export function buildAuthorizationRequest(
  request: TaskRequest,
  requestFingerprint: Fingerprint,
  plan: JsonObject,
  now: string,
  authorizationCycle = 1
): JsonObject {
  const planId = string(plan.planId, 'planId')
  const planRevision = number(plan.planRevision, 'planRevision')
  const steps = plan.steps
  if (!Array.isArray(steps)) throw new Error('Plano sem passos.')
  const actions: JsonObject[] = []
  let position = 0
  for (const rawStep of steps) {
    const step = object(rawStep, 'step')
    const stepActions = step.actions
    if (!Array.isArray(stepActions)) throw new Error('Passo sem ações.')
    for (const rawAction of stepActions) {
      const action = object(rawAction, 'action')
      position += 1
      const resourceRef = action.resourceRef
      const effectPolicy = object(action.effectPolicy, 'effectPolicy')
      const journaled = effectPolicy.mode === 'journaled'
      const item: JsonObject = {
        actionId: string(action.actionId, 'actionId'),
        stepRef: string(step.stepId, 'stepRef'),
        position,
        scope: string(action.scope, 'scope'),
        operation: string(action.operation, 'operation'),
        effectMode: journaled ? 'journaled' : 'none',
        effectClass: action.scope === 'runtime-internal'
          ? 'runtime-internal'
          : journaled
            ? 'reversible-change'
            : 'read-only',
        riskLevel: journaled ? 'medium' : 'low',
        requestedControls: action.scope === 'runtime-internal'
          ? []
          : journaled
            ? [
                'checkpoint-before-mutation',
                'verify-after-effect',
                'reconcile-before-retry',
                'revocation-check-before-effect'
              ]
            : ['sanitize-output']
      }
      if (typeof resourceRef === 'string') item.resourceRef = resourceRef
      if (journaled) item.effectKey = string(effectPolicy.effectKey, 'effectKey')
      actions.push(item)
    }
  }
  const journaledActions = actions.filter((item) => item.effectMode === 'journaled')
  const base: JsonObject = {
    contractVersion: '1.0',
    authorizationRequestId: stableId(
      'authreq',
      authorizationCycle === 1
        ? `${planId}:${planRevision}`
        : `${planId}:${planRevision}:cycle:${authorizationCycle}`
    ),
    createdAt: now,
    requester: { id: 'overcore-execution-environment', kind: 'execution-environment' },
    authorityProvider: { id: 'omni-authority-provider', kind: 'assistant' },
    requestBinding: {
      requestId: request.requestId,
      requestFingerprint,
      clientId: request.client.id
    },
    planBinding: {
      planId,
      planRevision,
      planFingerprint: object(plan.planFingerprint, 'planFingerprint'),
      strategyFingerprint: object(plan.strategyFingerprint, 'strategyFingerprint')
    },
    authorityCeiling: request.authority,
    actions,
    riskSummary: {
      maximumRisk: journaledActions.length > 0 ? 'medium' : 'low',
      triggeredBoundaries: [],
      requestResourceActionCount: actions.filter((item) => item.scope === 'request-resource').length,
      journaledEffectCount: journaledActions.length
    }
  }
  return { ...base, authorizationRequestFingerprint: fingerprint(base) }
}

export function buildEnforcement(
  taskId: string,
  authorizationRequest: JsonObject,
  decision: JsonObject,
  now: string,
  activatedAtStateRevision = 3
): JsonObject {
  const requestBinding = object(authorizationRequest.requestBinding, 'requestBinding')
  const planBinding = object(authorizationRequest.planBinding, 'planBinding')
  const actionDecisions = decision.actionDecisions
  if (!Array.isArray(actionDecisions)) throw new Error('Decisão sem ações.')
  const decisionFingerprint = object(decision.decisionFingerprint, 'decisionFingerprint')
  const limits = object(decision.limits, 'limits')
  const eligible = decision.outcome !== 'deny' && actionDecisions.every((item) => object(item, 'actionDecision').outcome === 'permit')
  const base: JsonObject = {
    modelVersion: '1.0',
    enforcementId: stableId('authenf', `${taskId}:${string(decision.decisionId, 'decisionId')}`),
    taskId,
    authorizationRequestBinding: {
      documentId: string(authorizationRequest.authorizationRequestId, 'authorizationRequestId'),
      fingerprint: object(authorizationRequest.authorizationRequestFingerprint, 'authorizationRequestFingerprint')
    },
    authorizationDecisionBinding: {
      documentId: string(decision.decisionId, 'decisionId'),
      fingerprint: decisionFingerprint
    },
    requestBinding: {
      requestId: string(requestBinding.requestId, 'requestId'),
      requestFingerprint: object(requestBinding.requestFingerprint, 'requestFingerprint')
    },
    planBinding,
    providerRef: string(object(decision.issuer, 'issuer').providerId, 'providerId'),
    status: eligible ? 'authorized' : 'denied',
    evaluatedAt: now,
    expiresAt: string(limits.expiresAt, 'expiresAt'),
    lastRevocationCheckAt: now,
    actionGrants: actionDecisions.map((raw) => {
      const item = object(raw, 'actionDecision')
      return {
        actionId: string(item.actionId, 'actionId'),
        outcome: item.outcome,
        requiredControls: item.requiredControls as never
      }
    }),
    activationEligible: eligible,
    activatedAtStateRevision
  }
  return { ...base, recordFingerprint: fingerprint(base) }
}

export function permittingDecision(authorizationRequest: JsonObject, now = new Date()): JsonObject {
  const actions = authorizationRequest.actions
  if (!Array.isArray(actions)) throw new Error('Pedido de autorização sem ações.')
  const base: JsonObject = {
    contractVersion: '1.0',
    decisionId: stableId('authdec', string(authorizationRequest.authorizationRequestId, 'authorizationRequestId')),
    authorizationRequestId: string(authorizationRequest.authorizationRequestId, 'authorizationRequestId'),
    issuedAt: now.toISOString(),
    issuer: {
      providerId: 'omni-authority-provider',
      providerKind: 'assistant',
      authorityBasisRef: 'omni-badge-primary-owner'
    },
    audience: { executionEnvironmentId: 'overcore-execution-environment', kind: 'execution-environment' },
    requestBinding: object(authorizationRequest.requestBinding, 'requestBinding'),
    planBinding: object(authorizationRequest.planBinding, 'planBinding'),
    outcome: 'permit-with-constraints',
    actionDecisions: actions.map((raw) => {
      const action = object(raw, 'action')
      return {
        actionId: string(action.actionId, 'actionId'),
        outcome: 'permit',
        reasonCode: 'within-delegated-authority',
        requiredControls: action.scope === 'runtime-internal'
          ? []
          : action.effectMode === 'journaled'
            ? [
                'checkpoint-before-mutation',
                'verify-after-effect',
                'reconcile-before-retry',
                'revocation-check-before-effect'
              ]
            : ['sanitize-output']
      }
    }),
    limits: {
      notBefore: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      maxDurationMs: 300_000
    },
    revocation: {
      mode: 'check-before-journaled-effect',
      statusRef: stableId('revocation-status', string(authorizationRequest.authorizationRequestId, 'authorizationRequestId')),
      failMode: 'fail-closed'
    },
    attestationRef: stableId('attestation-local-omni', string(authorizationRequest.authorizationRequestId, 'authorizationRequestId'))
  }
  return { ...base, decisionFingerprint: fingerprint(base) }
}
