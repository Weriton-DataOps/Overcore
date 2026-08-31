import { randomUUID } from 'node:crypto'

import { canonicalJson, fingerprint, scopeKey, stableId } from '../domain/fingerprint.js'
import type { Fingerprint, JsonObject, StoredTask, TaskRequest, TaskStatus } from '../domain/types.js'
import {
  ConcurrentTaskUpdateError,
  DuplicateTaskError,
  type AuthorityProvider,
  type TaskStore
} from '../ports/task-store.js'
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

const RECONCILABLE_STATUSES = new Set<TaskStatus>(['accepted', 'planning', 'ready'])
const RECONCILIATION_LEASE_MS = 30_000
const MAX_RECONCILIATION_TRANSITIONS = 3

export interface ReconciliationOutcome {
  taskId: string
  outcome: 'advanced' | 'unchanged' | 'busy' | 'failed'
  status?: TaskStatus
  error?: string
}

export type PreflightAdmissionErrorCode =
  | 'preflight-report-not-found'
  | 'preflight-report-integrity-failed'
  | 'preflight-report-not-ready'
  | 'preflight-report-stale'
  | 'preflight-execution-conflict'

export class PreflightAdmissionError extends Error {
  constructor(readonly code: PreflightAdmissionErrorCode, message: string) {
    super(message)
    this.name = 'PreflightAdmissionError'
  }
}

function assertSameExecutionIntent(existing: StoredTask, request: TaskRequest): void {
  if (canonicalJson(existing.request) !== canonicalJson(request)) {
    throw new PreflightAdmissionError(
      'preflight-execution-conflict',
      `A chave de execução ${request.idempotencyKey} já pertence à tarefa ${existing.taskId} com outro TaskRequest.`
    )
  }
}

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

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`)
  return value as JsonObject
}

function fingerprintValue(value: unknown, label: string): string {
  const found = object(value, label)
  if (found.algorithm !== 'sha256-jcs-v1' || typeof found.value !== 'string') {
    throw new Error(`${label} inválido.`)
  }
  return found.value
}

function assertEqual(left: unknown, right: unknown, message: string): void {
  if (canonicalJson(left as never) !== canonicalJson(right as never)) throw new Error(message)
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
  private readonly coordinatorId = `task-manager-${process.pid}-${randomUUID()}`

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

  async admitPrepared(reportId: string): Promise<StoredTask> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(reportId)) {
      throw new PreflightAdmissionError('preflight-report-not-found', 'Identidade de relatório inválida.')
    }
    const report = await this.store.findPreflightReport(reportId)
    if (!report) {
      throw new PreflightAdmissionError(
        'preflight-report-not-found',
        `Relatório de Preflight ${reportId} não foi encontrado.`
      )
    }
    const stored = await this.store.findPreflightRevision(report.draftId, report.draftRevision)
    if (!stored || stored.reportId !== reportId || canonicalJson(stored.report) !== canonicalJson(report)) {
      throw new PreflightAdmissionError(
        'preflight-report-integrity-failed',
        `Relatório ${reportId} não corresponde à revisão persistida do Preflight.`
      )
    }
    this.validator.preflightReport(stored.draft, stored.report)
    if (stored.report.status !== 'ready' || !stored.report.preparedRequest) {
      throw new PreflightAdmissionError(
        'preflight-report-not-ready',
        `Relatório ${reportId} está em ${stored.report.status} e não pode ser admitido.`
      )
    }

    const request = stored.report.preparedRequest
    const existing = await this.store.findByIdempotencyKey(request.idempotencyKey)
    if (existing) {
      assertSameExecutionIntent(existing, request)
      return (await this.reconcile(existing.taskId)) ?? existing
    }

    const latest = await this.store.findLatestPreflightByIdempotencyKey(stored.idempotencyKey)
    if (!latest || latest.reportId !== reportId) {
      throw new PreflightAdmissionError(
        'preflight-report-stale',
        `Relatório ${reportId} não é mais a revisão corrente do Preflight.`
      )
    }
    return this.submit(request)
  }

  async submit(document: unknown): Promise<StoredTask> {
    this.validator.taskRequest(document)
    const request = document
    const duplicate = await this.store.findByIdempotencyKey(request.idempotencyKey)
    if (duplicate) {
      assertSameExecutionIntent(duplicate, request)
      return (await this.reconcile(duplicate.taskId)) ?? duplicate
    }

    const now = this.clock.now().toISOString()
    const taskId = stableId('task', request.idempotencyKey)
    const requestFingerprint = fingerprint(request as never)
    const state = acceptedState(taskId, request, requestFingerprint, now)
    this.validator.taskState(state)
    const task: StoredTask = {
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
      await this.store.create(task, event(taskId, 1, 'task-accepted', now, {
        requestId: request.requestId,
        preflightReportId: String(request.preflight.readinessReportId)
      }))
    } catch (error) {
      if (error instanceof DuplicateTaskError) {
        const existing = await this.store.findById(error.existingTaskId)
        if (existing) {
          assertSameExecutionIntent(existing, request)
          return (await this.reconcile(existing.taskId)) ?? existing
        }
      }
      throw error
    }
    return (await this.reconcile(taskId)) ?? task
  }

  async reconcile(taskId: string): Promise<StoredTask | null> {
    let current = await this.store.findById(taskId)
    if (!current || !RECONCILABLE_STATUSES.has(current.status)) return current

    const claimToken = await this.store.claimReconciliation(
      taskId,
      this.coordinatorId,
      RECONCILIATION_LEASE_MS,
      this.clock.now()
    )
    if (!claimToken) return this.store.findById(taskId)

    try {
      for (let step = 0; step < MAX_RECONCILIATION_TRANSITIONS; step += 1) {
        current = await this.store.findById(taskId)
        if (!current || !RECONCILABLE_STATUSES.has(current.status)) return current
        try {
          if (current.status === 'accepted') current = await this.advanceAccepted(current)
          else if (current.status === 'planning') current = await this.advancePlanning(current)
          else current = await this.advanceReady(current)
        } catch (error) {
          if (error instanceof ConcurrentTaskUpdateError) continue
          throw error
        }
      }
      return this.store.findById(taskId)
    } finally {
      await this.store.releaseReconciliation(taskId, claimToken)
    }
  }

  async reconcilePending(limit = 32): Promise<ReconciliationOutcome[]> {
    const candidates = await this.store.listReconciliationCandidates(limit, this.clock.now())
    const outcomes: ReconciliationOutcome[] = []
    for (const candidate of candidates) {
      try {
        const before = candidate.status
        const reconciled = await this.reconcile(candidate.taskId)
        if (!reconciled) {
          outcomes.push({ taskId: candidate.taskId, outcome: 'failed', error: 'Tarefa desapareceu durante a reconciliação.' })
        } else if (RECONCILABLE_STATUSES.has(reconciled.status) && reconciled.status === before) {
          outcomes.push({ taskId: candidate.taskId, outcome: 'busy', status: reconciled.status })
        } else {
          outcomes.push({
            taskId: candidate.taskId,
            outcome: reconciled.status === before ? 'unchanged' : 'advanced',
            status: reconciled.status
          })
        }
      } catch (error) {
        outcomes.push({
          taskId: candidate.taskId,
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return outcomes
  }

  private async advanceAccepted(task: StoredTask): Promise<StoredTask> {
    const planningAt = this.clock.now().toISOString()
    const planningState = transition(task.state, 'planning', 'planning-started', planningAt)
    this.validator.taskState(planningState)
    return this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, planningState),
      event: event(task.taskId, planningState.stateRevision, 'planning-started', planningAt)
    })
  }

  private async advancePlanning(task: StoredTask): Promise<StoredTask> {
    const requestFingerprint = fingerprint(task.request as never)
    const stateRequestBinding = object(task.state.requestBinding, 'requestBinding')
    assertEqual(
      stateRequestBinding.requestFingerprint,
      requestFingerprint,
      'Task State está ligado a outro conteúdo de TaskRequest.'
    )
    const planAt = String(task.state.lifecycle.enteredAt)
    const plan = await buildInspectionPlan(
      task.taskId,
      task.request,
      requestFingerprint,
      task.stateRevision,
      planAt
    )
    this.validator.assert('execution-plan', plan)
    assertFingerprint(plan, 'planFingerprint')
    const authRequest = buildAuthorizationRequest(task.request, requestFingerprint, plan, planAt)
    this.validator.assert('authorization-request', authRequest)
    assertFingerprint(authRequest, 'authorizationRequestFingerprint')
    const decision = await this.authorityProvider.evaluate(authRequest)
    this.validator.assert('authorization-decision', decision)
    assertFingerprint(decision, 'decisionFingerprint')
    assertDecisionMatches(task.request, authRequest, decision, this.clock.now())
    const enforcementAt = this.clock.now().toISOString()
    const enforcement = buildEnforcement(task.taskId, authRequest, decision, enforcementAt)
    this.validator.assert('authorization-enforcement', enforcement)
    assertFingerprint(enforcement, 'recordFingerprint')

    const readyState = bindReadyState(task.state, {
      planId: String(plan.planId),
      planRevision: Number(plan.planRevision),
      planFingerprint: plan.planFingerprint as Fingerprint,
      strategyFingerprint: plan.strategyFingerprint as Fingerprint,
      basisStateRevision: Number(object(plan.taskBinding, 'taskBinding').basisStateRevision),
      authorization: {
        enforcementId: String(enforcement.enforcementId),
        enforcementFingerprint: enforcement.recordFingerprint as Fingerprint,
        decisionId: String(decision.decisionId),
        decisionFingerprint: decision.decisionFingerprint as Fingerprint,
        expiresAt: String(enforcement.expiresAt),
        activatedAtRevision: task.stateRevision + 1
      }
    }, enforcementAt)
    this.validator.taskState(readyState)
    return this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, readyState),
      event: event(task.taskId, readyState.stateRevision, 'plan-authorized', enforcementAt, {
        planId: String(plan.planId),
        decisionId: String(decision.decisionId)
      }),
      plan,
      authorization: { request: authRequest, decision, enforcement }
    })
  }

  private async advanceReady(task: StoredTask): Promise<StoredTask> {
    const binding = object(task.state.activePlanBinding, 'activePlanBinding')
    const planId = String(binding.planId)
    const planRevision = Number(binding.planRevision)
    const authorizationBinding = object(binding.authorizationBinding, 'authorizationBinding')
    const plan = await this.store.findPlan(task.taskId, planId, planRevision)
    if (!plan) throw new Error(`Plano ${planId}@${planRevision} não foi encontrado para retomar a tarefa.`)
    const authorization = await this.store.findAuthorization(task.taskId, String(authorizationBinding.decisionId))
    if (!authorization) throw new Error('Autorização persistida não foi encontrada para retomar a tarefa.')

    this.validator.assert('execution-plan', plan)
    this.validator.assert('authorization-request', authorization.request)
    this.validator.assert('authorization-decision', authorization.decision)
    this.validator.assert('authorization-enforcement', authorization.enforcement)
    assertFingerprint(plan, 'planFingerprint')
    assertFingerprint(authorization.request, 'authorizationRequestFingerprint')
    assertFingerprint(authorization.decision, 'decisionFingerprint')
    assertFingerprint(authorization.enforcement, 'recordFingerprint')
    assertDecisionMatches(task.request, authorization.request, authorization.decision, this.clock.now())

    assertEqual(plan.planFingerprint, binding.planFingerprint, 'Fingerprint do plano persistido diverge do Task State.')
    assertEqual(plan.strategyFingerprint, binding.strategyFingerprint, 'Estratégia persistida diverge do Task State.')
    assertEqual(
      authorization.decision.decisionFingerprint,
      authorizationBinding.decisionFingerprint,
      'Decisão persistida diverge do Task State.'
    )
    assertEqual(
      authorization.enforcement.recordFingerprint,
      authorizationBinding.enforcementFingerprint,
      'Enforcement persistido diverge do Task State.'
    )
    if (authorization.enforcement.enforcementId !== authorizationBinding.enforcementId) {
      throw new Error('Enforcement persistido pertence a outra autorização.')
    }
    if (authorization.enforcement.expiresAt !== authorizationBinding.expiresAt) {
      throw new Error('Validade do enforcement diverge do Task State.')
    }

    const runningAt = this.clock.now().toISOString()
    const runningState = startAttempt(
      task.state,
      planId,
      planRevision,
      plan.strategyFingerprint as Fingerprint,
      runningAt
    )
    this.validator.taskState(runningState)
    const outboxId = stableId('outbox-inspection', `${task.taskId}:${runningState.executionEpoch}`)
    const authorizedActions = authorization.request.actions as JsonObject[]
    const actionDecisions = authorization.decision.actionDecisions as JsonObject[]
    const permittedActionIds = new Set(
      actionDecisions.filter((item) => item.outcome === 'permit').map((item) => String(item.actionId))
    )
    return this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, runningState),
      event: event(task.taskId, runningState.stateRevision, 'execution-scheduled', runningAt, { outboxId }),
      outbox: {
        outboxId,
        taskId: task.taskId,
        kind: 'execute-inspection',
        payload: {
          repositoryUri: repositoryUri(task.request),
          objective: task.request.objective,
          budget: task.request.budget,
          runtimeAuthorization: {
            enforcementId: String(authorization.enforcement.enforcementId),
            enforcementFingerprint: fingerprintValue(authorization.enforcement.recordFingerprint, 'recordFingerprint'),
            expiresAt: String(authorization.enforcement.expiresAt),
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
  }

  async get(taskId: string): Promise<StoredTask | null> {
    return this.store.findById(taskId)
  }
}
