import { canonicalJson, fingerprint, scopeKey, stableId } from '../domain/fingerprint.js'
import type { JsonObject, StoredTask, TaskRequest } from '../domain/types.js'
import { DuplicateTaskError, type AuthorityProvider, type TaskStore } from '../ports/task-store.js'
import { ContractValidator } from '../contracts/validator.js'
import { buildAuthorizationRequest, buildEnforcement } from './authorization.js'
import { buildInspectionPlan, repositoryUri } from './inspection-plan.js'
import { acceptedState, bindReadyState, startAttempt, transition } from './state-builder.js'
import { BaselineDiscovery } from './baseline-discovery.js'
import { TaskPreflight } from './task-preflight.js'

export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

function event(taskId: string, revision: number, kind: string, occurredAt: string, payload: JsonObject = {}) {
  return {
    eventId: stableId('event', `${taskId}:${revision}:${kind}`),
    kind,
    occurredAt,
    payload
  }
}

function record(previous: StoredTask, state: StoredTask['state'], result?: JsonObject): StoredTask {
  const next: StoredTask = {
    ...previous,
    status: state.lifecycle.state,
    stateRevision: state.stateRevision,
    executionEpoch: state.executionEpoch,
    state,
    updatedAt: state.updatedAt
  }
  if (result) next.result = result
  return next
}

function assertFingerprint(document: JsonObject, field: string): void {
  const declared = document[field]
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error(`${field} ausente.`)
  }
  const basis = structuredClone(document)
  delete basis[field]
  if (canonicalJson(declared) !== canonicalJson(fingerprint(basis))) {
    throw new Error(`${field} não corresponde ao conteúdo recebido.`)
  }
}

function assertDecisionMatches(request: TaskRequest, authRequest: JsonObject, decision: JsonObject, at: Date): void {
  if (decision.authorizationRequestId !== authRequest.authorizationRequestId) {
    throw new Error('Omni respondeu a outro pedido de autorização.')
  }
  for (const field of ['requestBinding', 'planBinding'] as const) {
    if (canonicalJson(decision[field] as never) !== canonicalJson(authRequest[field] as never)) {
      throw new Error(`Decisão do Omni diverge em ${field}.`)
    }
  }
  if (decision.outcome === 'deny') throw new Error('Omni negou a ativação do plano.')
  const limits = decision.limits as JsonObject
  if (!limits || Date.parse(String(limits.notBefore)) > at.getTime()) throw new Error('Decisão do Omni ainda não entrou em vigor.')
  if (Date.parse(String(limits.expiresAt)) <= at.getTime()) throw new Error('Decisão do Omni já expirou.')
  if (Number(limits.maxDurationMs) > request.budget.maxDurationMs) {
    throw new Error('Decisão do Omni ampliou o orçamento temporal da tarefa.')
  }
  const authorityProvider = authRequest.authorityProvider as JsonObject
  const issuer = decision.issuer as JsonObject
  if (issuer.providerId !== authorityProvider.id || issuer.providerKind !== authorityProvider.kind) {
    throw new Error('Decisão veio de outro Authority Provider.')
  }
  const requested = new Set((authRequest.actions as JsonObject[]).map((item) => String(item.actionId)))
  const decisions = decision.actionDecisions as JsonObject[]
  const permitted = new Set(decisions.filter((item) => item.outcome === 'permit').map((item) => String(item.actionId)))
  if (decisions.length !== requested.size || requested.size !== permitted.size || [...requested].some((id) => !permitted.has(id))) {
    throw new Error('Decisão do Omni não permitiu exatamente todas as ações do plano.')
  }
  const requestedById = new Map((authRequest.actions as JsonObject[]).map((item) => [String(item.actionId), item]))
  for (const item of decisions) {
    const action = requestedById.get(String(item.actionId))
    if (!action) throw new Error('Decisão contém ação que não pertence ao plano.')
    const required = new Set(Array.isArray(action.requestedControls) ? action.requestedControls.map(String) : [])
    const granted = new Set(Array.isArray(item.requiredControls) ? item.requiredControls.map(String) : [])
    if ([...required].some((control) => !granted.has(control))) {
      throw new Error(`Decisão removeu controle solicitado da ação ${String(item.actionId)}.`)
    }
  }
}

export class TaskManager {
  private readonly preflight: TaskPreflight

  constructor(
    private readonly store: TaskStore,
    private readonly validator: ContractValidator,
    private readonly authorityProvider: AuthorityProvider,
    private readonly clock: Clock = systemClock,
    preflight?: TaskPreflight
  ) {
    this.preflight = preflight ?? new TaskPreflight(validator, new BaselineDiscovery(), store, clock)
  }

  async prepare(document: unknown) {
    return this.preflight.run(document)
  }

  async submit(document: unknown): Promise<StoredTask> {
    this.validator.taskRequest(document)
    const request = document
    const duplicate = await this.store.findByIdempotencyKey(request.idempotencyKey)
    if (duplicate) return duplicate

    const now = this.clock.now().toISOString()
    const taskId = stableId('task', request.idempotencyKey)
    const requestFingerprint = fingerprint(request as never)
    const state = acceptedState(taskId, request, requestFingerprint, now)
    this.validator.taskState(state)
    let task: StoredTask = {
      taskId,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      scopeKey: scopeKey(request),
      status: 'accepted',
      stateRevision: 1,
      executionEpoch: 1,
      request,
      state,
      createdAt: now,
      updatedAt: now
    }
    try {
      task = await this.store.create(task, event(taskId, 1, 'task-accepted', now, { requestId: request.requestId }))
    } catch (error) {
      if (error instanceof DuplicateTaskError) {
        const existing = await this.store.findById(error.existingTaskId)
        if (existing) return existing
      }
      throw error
    }

    const planningAt = this.clock.now().toISOString()
    const planningState = transition(task.state, 'planning', 'planning-started', planningAt)
    this.validator.taskState(planningState)
    task = await this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, planningState),
      event: event(taskId, planningState.stateRevision, 'planning-started', planningAt)
    })

    const planAt = this.clock.now().toISOString()
    const plan = await buildInspectionPlan(taskId, request, requestFingerprint, planningState.stateRevision, planAt)
    this.validator.assert('execution-plan', plan)
    assertFingerprint(plan, 'planFingerprint')
    const authRequest = buildAuthorizationRequest(request, requestFingerprint, plan, planAt)
    this.validator.assert('authorization-request', authRequest)
    assertFingerprint(authRequest, 'authorizationRequestFingerprint')
    const decision = await this.authorityProvider.evaluate(authRequest)
    this.validator.assert('authorization-decision', decision)
    assertFingerprint(decision, 'decisionFingerprint')
    assertDecisionMatches(request, authRequest, decision, this.clock.now())
    const enforcementAt = this.clock.now().toISOString()
    const enforcement = buildEnforcement(taskId, authRequest, decision, enforcementAt)
    this.validator.assert('authorization-enforcement', enforcement)
    assertFingerprint(enforcement, 'recordFingerprint')

    const readyState = bindReadyState(task.state, {
      planId: String(plan.planId),
      planRevision: Number(plan.planRevision),
      planFingerprint: plan.planFingerprint as never,
      strategyFingerprint: plan.strategyFingerprint as never,
      basisStateRevision: Number((plan.taskBinding as JsonObject).basisStateRevision),
      authorization: {
        enforcementId: String(enforcement.enforcementId),
        enforcementFingerprint: enforcement.recordFingerprint as never,
        decisionId: String(decision.decisionId),
        decisionFingerprint: decision.decisionFingerprint as never,
        expiresAt: String(enforcement.expiresAt),
        activatedAtRevision: 3
      }
    }, enforcementAt)
    this.validator.taskState(readyState)
    task = await this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, readyState),
      event: event(taskId, readyState.stateRevision, 'plan-authorized', enforcementAt, {
        planId: String(plan.planId),
        decisionId: String(decision.decisionId)
      }),
      plan,
      authorization: { request: authRequest, decision, enforcement }
    })

    const runningAt = this.clock.now().toISOString()
    const runningState = startAttempt(
      task.state,
      String(plan.planId),
      Number(plan.planRevision),
      plan.strategyFingerprint as never,
      runningAt
    )
    this.validator.taskState(runningState)
    const outboxId = stableId('outbox-inspection', `${taskId}:${runningState.executionEpoch}`)
    const authorizedActions = authRequest.actions as JsonObject[]
    const actionDecisions = decision.actionDecisions as JsonObject[]
    const permittedActionIds = new Set(
      actionDecisions.filter((item) => item.outcome === 'permit').map((item) => String(item.actionId))
    )
    const recordFingerprint = enforcement.recordFingerprint as JsonObject
    task = await this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, runningState),
      event: event(taskId, runningState.stateRevision, 'execution-scheduled', runningAt, { outboxId }),
      outbox: {
        outboxId,
        taskId,
        kind: 'execute-inspection',
        payload: {
          repositoryUri: repositoryUri(request),
          objective: request.objective,
          budget: request.budget,
          runtimeAuthorization: {
            enforcementId: String(enforcement.enforcementId),
            enforcementFingerprint: String(recordFingerprint.value),
            expiresAt: String(enforcement.expiresAt),
            operations: [...new Set(authorizedActions
              .filter((item) => permittedActionIds.has(String(item.actionId)))
              .map((item) => String(item.operation)))],
            requiredControls: [...new Set(actionDecisions.flatMap((item) =>
              Array.isArray(item.requiredControls) ? item.requiredControls.map(String) : []
            ))]
          }
        },
        availableAt: runningAt,
        attempts: 0
      }
    })
    return task
  }

  async get(taskId: string): Promise<StoredTask | null> {
    return this.store.findById(taskId)
  }
}
