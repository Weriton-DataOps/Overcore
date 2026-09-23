import { randomUUID } from 'node:crypto'

import { canonicalJson, fingerprint, scopeKey, sha256, stableId } from '../domain/fingerprint.js'
import type { Fingerprint, JsonObject, StoredTask, TaskRequest, TaskStatus } from '../domain/types.js'
import {
  ConcurrentTaskUpdateError,
  DuplicateTaskError,
  AuthorityProviderError,
  type AuthorityProvider,
  type TaskStore
} from '../ports/task-store.js'
import { ContractValidator } from '../contracts/validator.js'
import { buildAuthorizationRequest, buildEnforcement } from './authorization.js'
import { buildInspectionPlan, repositoryUri } from './inspection-plan.js'
import { buildFileReplacementPlan } from './file-replacement-plan.js'
import { fileReplacementFrom, replacementPayloadFromPlan } from './file-replacement.js'
import { buildPostgresTableProbePlan } from './postgres-table-probe-plan.js'
import { postgresTableProbeFrom, probePayloadFromPlan } from './postgres-table-probe.js'
import {
  acceptedState,
  attachResultReference,
  bindReadyState,
  blockTaskState,
  requestCancellation,
  refreshReadyAuthorization,
  resumeBlockedState,
  startAttempt,
  transition
} from './state-builder.js'
import { BaselineDiscovery } from './baseline-discovery.js'
import { TaskPreflight } from './task-preflight.js'
import { finishCancellation } from './task-cancellation.js'

export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

const RECONCILABLE_STATUSES = new Set<TaskStatus>(['accepted', 'planning', 'ready', 'cancelling'])
const RECONCILIATION_LEASE_MS = 30_000
const MAX_RECONCILIATION_TRANSITIONS = 3

export interface ReconciliationOutcome {
  taskId: string
  outcome: 'advanced' | 'unchanged' | 'busy' | 'deferred' | 'failed'
  status?: TaskStatus
  retryAt?: string
  error?: string
}

class AuthorizationDeniedError extends Error {
  constructor() {
    super('Omni negou a ativação do plano.')
    this.name = 'AuthorizationDeniedError'
  }
}

class AuthorizationNotYetValidError extends Error {
  constructor(readonly notBefore: Date) {
    super('Decisão do Omni ainda não entrou em vigor.')
    this.name = 'AuthorizationNotYetValidError'
  }
}

class AuthorizationExpiredError extends Error {
  constructor() {
    super('Decisão do Omni já expirou.')
    this.name = 'AuthorizationExpiredError'
  }
}

interface BlockDescriptor {
  code: string
  kind: 'authority' | 'resource' | 'external-condition'
  summary: string
  condition: string
  reason: string
  question: string
  options: Array<{ id: string; label: string; consequence: string }>
  impact: string
  resumeTarget: 'planning' | 'ready'
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
  if (decision.outcome === 'deny') throw new AuthorizationDeniedError()
  const limits = decision.limits as JsonObject
  if (!limits) throw new Error('Decisão do Omni não declarou limites.')
  const notBefore = new Date(String(limits.notBefore))
  if (notBefore.getTime() > at.getTime()) throw new AuthorizationNotYetValidError(notBefore)
  if (Date.parse(String(limits.expiresAt)) <= at.getTime()) throw new AuthorizationExpiredError()
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
    if (current.status === 'cancelling') return this.cancel(taskId)

    const claimToken = await this.store.claimReconciliation(
      taskId,
      this.coordinatorId,
      RECONCILIATION_LEASE_MS,
      this.clock.now()
    )
    if (!claimToken) return this.store.findById(taskId)

    let deferred = false
    try {
      for (let step = 0; step < MAX_RECONCILIATION_TRANSITIONS; step += 1) {
        current = await this.store.findById(taskId)
        if (!current || !RECONCILABLE_STATUSES.has(current.status)) return current
        try {
          if (current.status === 'cancelling') return await this.cancel(current.taskId)
          if (current.status === 'accepted') current = await this.advanceAccepted(current)
          else if (current.status === 'planning') current = await this.advancePlanning(current)
          else current = await this.advanceReady(current)
        } catch (error) {
          if (error instanceof ConcurrentTaskUpdateError) continue
          throw error
        }
      }
      return this.store.findById(taskId)
    } catch (error) {
      current = await this.store.findById(taskId)
      if (!current || !RECONCILABLE_STATUSES.has(current.status)) throw error
      const block = this.blockDescriptor(error, current)
      if (block) return await this.block(current, block, error)

      const occurredAt = this.clock.now()
      const delayMs = this.retryDelay(error, current.reconciliation?.failureCount ?? 0, occurredAt)
      await this.store.deferReconciliation(taskId, claimToken, {
        code: this.recoveryCode(error),
        errorFingerprint: sha256(canonicalJson({
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
          code: this.recoveryCode(error)
        })),
        occurredAt,
        retryAt: new Date(occurredAt.getTime() + delayMs)
      })
      deferred = true
      return this.store.findById(taskId)
    } finally {
      if (!deferred) await this.store.releaseReconciliation(taskId, claimToken)
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
        } else if (reconciled.reconciliation) {
          outcomes.push({
            taskId: candidate.taskId,
            outcome: 'deferred',
            status: reconciled.status,
            retryAt: reconciled.reconciliation.retryAt,
            error: reconciled.reconciliation.errorCode
          })
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

  async resume(taskId: string): Promise<StoredTask | null> {
    const task = await this.store.findById(taskId)
    if (!task || task.status !== 'blocked') return task
    const resumedAt = this.clock.now().toISOString()
    const resumedState = resumeBlockedState(task.state, resumedAt)
    this.validator.taskState(resumedState)
    try {
      await this.store.compareAndSwap({
        expectedRevision: task.stateRevision,
        next: record(task, resumedState),
        event: event(task.taskId, resumedState.stateRevision, 'condition-restored', resumedAt, {
          blockId: String(task.state.activeBlockRef),
          resumeTarget: resumedState.lifecycle.state
        })
      })
    } catch (error) {
      if (!(error instanceof ConcurrentTaskUpdateError)) throw error
    }
    return this.reconcile(taskId)
  }

  async cancel(taskId: string): Promise<StoredTask | null> {
    for (let retry = 0; retry < 8; retry += 1) {
      let task = await this.store.findById(taskId)
      if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.status)) return task
      try {
        if (task.status !== 'cancelling') {
          const at = this.clock.now().toISOString()
          const evidenceRef = stableId('evidence-cancel-request', `${taskId}:${task.stateRevision}`)
          const state = requestCancellation(task.state, evidenceRef, 'client', at)
          this.validator.taskState(state)
          task = await this.store.compareAndSwap({ expectedRevision: task.stateRevision, next: record(task, state),
            event: { eventId: stableId('event-cancellation-requested', `${taskId}:${state.stateRevision}`),
              kind: 'cancellation-requested', occurredAt: at, payload: { evidenceRef, initiatedBy: 'client' } } })
        }
        // Any dispatched attempt is settled by the owning worker, including recovery after a crash.
        if ((task.state.ledger.attempts as JsonObject[]).some((attempt) => attempt.status !== 'failed')) return task
        return await finishCancellation(this.store, this.validator, task, () => this.clock.now())
      } catch (error) {
        if (!(error instanceof ConcurrentTaskUpdateError)) throw error
      }
    }
    throw new Error('Cancelamento disputou várias revisões; repita o mesmo pedido idempotente.')
  }

  private recoveryCode(error: unknown): string {
    if (error instanceof AuthorityProviderError) return error.code
    if (error instanceof AuthorizationNotYetValidError) return 'authorization-not-yet-valid'
    if (error instanceof AuthorizationExpiredError) return 'authorization-expired'
    const systemCode = (error as NodeJS.ErrnoException | undefined)?.code
    if (typeof systemCode === 'string') return `system-${systemCode.toLowerCase()}`
    return 'reconciliation-internal-error'
  }

  private retryDelay(error: unknown, previousFailures: number, now: Date): number {
    if (error instanceof AuthorizationNotYetValidError) {
      return Math.max(250, error.notBefore.getTime() - now.getTime())
    }
    if (error instanceof AuthorityProviderError && error.retryAfterMs !== undefined) {
      return Math.min(300_000, Math.max(1_000, error.retryAfterMs))
    }
    return Math.min(30_000, 1_000 * (2 ** Math.min(previousFailures, 5)))
  }

  private blockDescriptor(error: unknown, task: StoredTask): BlockDescriptor | null {
    const resumeTarget = task.status === 'ready' ? 'ready' : 'planning'
    if (error instanceof AuthorizationDeniedError) {
      return {
        code: 'block-authorization-denied',
        kind: 'authority',
        summary: 'O Omni negou a autorização do plano; nenhuma execução foi iniciada.',
        condition: 'O mesmo plano precisa receber uma nova autorização válida do Omni.',
        reason: 'O plano atual não recebeu autoridade suficiente para executar suas ações.',
        question: 'O crachá ou a política do Omni foi ajustado para permitir uma nova avaliação deste plano?',
        options: [{
          id: 'option-retry-authorization',
          label: 'Avaliar novamente',
          consequence: 'A mesma tarefa retorna à fase segura e solicita outra decisão para o plano.'
        }],
        impact: 'A tarefa permanece parada e nenhum executor recebe trabalho.',
        resumeTarget
      }
    }
    if (error instanceof AuthorityProviderError && !error.retryable) {
      return {
        code: 'block-authority-provider-invalid',
        kind: 'authority',
        summary: 'A resposta permanente da porta do Omni impediu a autorização do plano.',
        condition: 'A porta local do Omni precisa voltar a aceitar o contrato de autorização.',
        reason: error.message,
        question: 'A integração local do Omni foi corrigida para que a autorização possa ser avaliada novamente?',
        options: [{
          id: 'option-retry-authority-port',
          label: 'Testar novamente',
          consequence: 'O Overcore retoma da fase segura e consulta a mesma porta contratada.'
        }],
        impact: 'Nenhuma tentativa ou ferramenta é iniciada enquanto a porta permanecer inválida.',
        resumeTarget
      }
    }
    if (error instanceof AuthorizationExpiredError) {
      return {
        code: 'block-invalid-fresh-authorization',
        kind: 'authority',
        summary: 'O Omni devolveu uma autorização que já estava vencida.',
        condition: 'O Omni precisa emitir uma decisão nova com janela de validade futura.',
        reason: error.message,
        question: 'O relógio e a emissão de autorizações do Omni foram corrigidos?',
        options: [{
          id: 'option-retry-fresh-authorization',
          label: 'Solicitar novamente',
          consequence: 'O Overcore repete a avaliação com uma nova identidade de ciclo.'
        }],
        impact: 'O plano não é ativado com uma autorização vencida.',
        resumeTarget
      }
    }
    const systemCode = (error as NodeJS.ErrnoException | undefined)?.code
    if (systemCode === 'ENOENT' || systemCode === 'EACCES' || systemCode === 'EPERM') {
      return {
        code: 'block-resource-unavailable',
        kind: 'resource',
        summary: 'Um recurso necessário ao planejamento não pôde ser lido.',
        condition: 'A referência original precisa existir e estar legível para o Overcore.',
        reason: error instanceof Error ? error.message : String(error),
        question: 'O recurso original foi restaurado com acesso de leitura?',
        options: [{
          id: 'option-retry-original-resource',
          label: 'Verificar novamente',
          consequence: 'A mesma tarefa volta ao planejamento sem trocar silenciosamente sua referência.'
        }],
        impact: 'O planejamento fica pausado e nenhuma execução é iniciada.',
        resumeTarget: 'planning'
      }
    }
    return null
  }

  private async block(task: StoredTask, descriptor: BlockDescriptor, error: unknown): Promise<StoredTask> {
    const blockedAt = this.clock.now().toISOString()
    const seed = `${task.taskId}:${task.stateRevision + 1}:${descriptor.code}`
    const blockId = stableId('block', seed)
    const resultId = stableId('result-blocked', seed)
    const evidenceId = stableId('evidence-block', seed)
    let blockedState = blockTaskState(task.state, {
      blockId,
      resultId,
      evidenceId,
      resumeTarget: descriptor.resumeTarget,
      mode: 'resume-same-request',
      condition: descriptor.condition
    }, blockedAt)
    const resultRefs = object(blockedState.ledger, 'ledger').resultRefs
    const emissionSequence = Array.isArray(resultRefs) ? resultRefs.length + 1 : 1
    const usage = object(blockedState.usage, 'usage')
    const evidenceBasis = {
      taskId: task.taskId,
      stateRevision: blockedState.stateRevision,
      code: descriptor.code,
      errorName: error instanceof Error ? error.name : 'Error',
      errorMessage: error instanceof Error ? error.message : String(error)
    }
    const result: JsonObject = {
      contractVersion: '1.0',
      resultId,
      requestId: task.requestId,
      requestFingerprint: object(task.state.requestBinding, 'requestBinding').requestFingerprint,
      taskId: task.taskId,
      stateRef: {
        stateRevision: blockedState.stateRevision,
        transitionId: blockedState.lifecycle.lastTransitionId,
        emissionSequence
      },
      reportedAt: blockedAt,
      status: 'blocked',
      summary: descriptor.summary,
      criteria: blockedState.criterionProgress.map((item) => ({
        criterionId: String(item.criterionId),
        status: item.status,
        evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []
      })),
      evidence: [{
        evidenceId,
        kind: 'state-readback',
        capturedAt: blockedAt,
        summary: descriptor.reason,
        digest: sha256(canonicalJson(evidenceBasis)),
        artifactRefs: [],
        origin: { kind: 'runtime', id: 'overcore-runtime-v1' }
      }],
      artifacts: [],
      effects: [],
      execution: {
        attemptCount: Number(usage.attemptCount ?? 0),
        maxParallelismObserved: Number(usage.maxParallelismObserved ?? 0),
        durationMs: Number(usage.activeDurationMs ?? 0),
        lastTransitionAt: blockedAt
      },
      inputRequired: {
        blockId,
        mode: 'resume-same-request',
        code: descriptor.code,
        kind: descriptor.kind,
        reason: descriptor.reason,
        question: descriptor.question,
        options: descriptor.options,
        impact: descriptor.impact,
        evidenceRefs: [evidenceId]
      }
    }
    this.validator.assert('task-result', result)
    blockedState = attachResultReference(blockedState, resultId, fingerprint(result), 'blocked', blockedAt)
    this.validator.taskState(blockedState)
    return this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, blockedState, result),
      event: event(task.taskId, blockedState.stateRevision, 'block-detected', blockedAt, {
        blockId,
        code: descriptor.code,
        evidenceId
      })
    })
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
    const priorPlanRefs = Array.isArray(task.state.ledger.planRefs)
      ? task.state.ledger.planRefs as JsonObject[]
      : []
    const planRevision = priorPlanRefs.length + 1
    const replacement = fileReplacementFrom(task.request)
    const postgresProbe = postgresTableProbeFrom(task.request)
    const plan = replacement
      ? buildFileReplacementPlan(
          task.taskId,
          task.request,
          requestFingerprint,
          task.stateRevision,
          planAt,
          planRevision,
          priorPlanRefs.at(-1)
        )
      : postgresProbe
        ? buildPostgresTableProbePlan(
            task.taskId,
            task.request,
            requestFingerprint,
            task.stateRevision,
            planAt,
            planRevision,
            priorPlanRefs.at(-1)
          )
      : await buildInspectionPlan(
          task.taskId,
          task.request,
          requestFingerprint,
          task.stateRevision,
          planAt,
          planRevision,
          priorPlanRefs.at(-1)
        )
    this.validator.assert('execution-plan', plan)
    assertFingerprint(plan, 'planFingerprint')
    const authRequest = buildAuthorizationRequest(
      task.request,
      requestFingerprint,
      plan,
      planAt,
      task.stateRevision === 2 ? 1 : task.stateRevision
    )
    this.validator.assert('authorization-request', authRequest)
    assertFingerprint(authRequest, 'authorizationRequestFingerprint')
    const decision = await this.evaluateAuthorization(authRequest)
    this.assertAuthorizationMatches(task.request, authRequest, decision)
    const enforcementAt = this.clock.now().toISOString()
    const enforcement = buildEnforcement(
      task.taskId,
      authRequest,
      decision,
      enforcementAt,
      task.stateRevision + 1
    )
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

  private async evaluateAuthorization(authRequest: JsonObject): Promise<JsonObject> {
    const decision = await this.authorityProvider.evaluate(authRequest)
    try {
      this.validator.assert('authorization-decision', decision)
      assertFingerprint(decision, 'decisionFingerprint')
    } catch (error) {
      throw new AuthorityProviderError(
        'authority-provider-invalid-decision',
        false,
        `Authority Provider devolveu decisão inválida: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return decision
  }

  private assertAuthorizationMatches(request: TaskRequest, authRequest: JsonObject, decision: JsonObject): void {
    try {
      assertDecisionMatches(request, authRequest, decision, this.clock.now())
    } catch (error) {
      if (error instanceof AuthorizationDeniedError || error instanceof AuthorizationNotYetValidError || error instanceof AuthorizationExpiredError) throw error
      // A well-formed but incompatible decision will not repair itself by retrying
      // the same plan. Expose the exact contract problem instead of a backoff loop.
      throw new AuthorityProviderError(
        'authority-provider-incompatible-decision', false,
        `Decisão incompatível com a tarefa: ${error instanceof Error ? error.message : String(error)}`
      )
    }
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
    if (Date.parse(String(authorization.enforcement.expiresAt)) <= this.clock.now().getTime()) {
      return this.refreshAuthorization(task, plan)
    }
    this.assertAuthorizationMatches(task.request, authorization.request, authorization.decision)

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
    const replacement = fileReplacementFrom(task.request)
    const postgresProbe = postgresTableProbeFrom(task.request)
    const outboxId = stableId(
      replacement ? 'outbox-file-replacement' : postgresProbe ? 'outbox-postgres-table-probe' : 'outbox-inspection',
      `${task.taskId}:${runningState.executionEpoch}`
    )
    const authorizedActions = authorization.request.actions as JsonObject[]
    const actionDecisions = authorization.decision.actionDecisions as JsonObject[]
    const permittedActionIds = new Set(
      actionDecisions.filter((item) => item.outcome === 'permit').map((item) => String(item.actionId))
    )
    const runtimeAuthorization: JsonObject = {
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
    const payload: JsonObject = replacement
      ? (() => {
          const binding = replacementPayloadFromPlan(plan)
          return {
            objective: task.request.objective,
            budget: task.request.budget,
            execution: replacement.execution,
            targetUri: replacement.targetUri,
            effectKey: binding.effectKey,
            actionId: binding.actionId,
            runtimeAuthorization: {
              ...runtimeAuthorization,
              authorizationRequest: authorization.request
            }
          }
        })()
      : postgresProbe
        ? (() => {
            const binding = probePayloadFromPlan(plan)
            return {
              objective: task.request.objective,
              budget: task.request.budget,
              execution: postgresProbe.execution,
              targetUri: postgresProbe.targetUri,
              effectKey: binding.effectKey,
              actionId: binding.actionId,
              runtimeAuthorization: {
                ...runtimeAuthorization,
                authorizationRequest: authorization.request
              }
            }
          })()
      : {
          repositoryUri: repositoryUri(task.request),
          objective: task.request.objective,
          strategyRevision: planRevision,
          budget: task.request.budget,
          runtimeAuthorization
        }
    return this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, runningState),
      event: event(task.taskId, runningState.stateRevision, 'execution-scheduled', runningAt, { outboxId }),
      outbox: {
        outboxId,
        taskId: task.taskId,
        kind: replacement ? 'execute-file-replacement' : postgresProbe ? 'execute-postgres-table-probe' : 'execute-inspection',
        payload,
        availableAt: runningAt,
        attempts: 0
      }
    })
  }

  private async refreshAuthorization(task: StoredTask, plan: JsonObject): Promise<StoredTask> {
    const refreshedAt = this.clock.now().toISOString()
    const requestFingerprint = fingerprint(task.request as never)
    const authorizationCycle = task.stateRevision + 1
    const authRequest = buildAuthorizationRequest(
      task.request,
      requestFingerprint,
      plan,
      refreshedAt,
      authorizationCycle
    )
    this.validator.assert('authorization-request', authRequest)
    assertFingerprint(authRequest, 'authorizationRequestFingerprint')
    const decision = await this.evaluateAuthorization(authRequest)
    this.assertAuthorizationMatches(task.request, authRequest, decision)
    const enforcementAt = this.clock.now().toISOString()
    const enforcement = buildEnforcement(
      task.taskId,
      authRequest,
      decision,
      enforcementAt,
      task.stateRevision + 1
    )
    this.validator.assert('authorization-enforcement', enforcement)
    assertFingerprint(enforcement, 'recordFingerprint')
    const refreshedState = refreshReadyAuthorization(task.state, {
      enforcementId: String(enforcement.enforcementId),
      enforcementFingerprint: enforcement.recordFingerprint as Fingerprint,
      decisionId: String(decision.decisionId),
      decisionFingerprint: decision.decisionFingerprint as Fingerprint,
      expiresAt: String(enforcement.expiresAt),
      activatedAtRevision: task.stateRevision + 1
    }, enforcementAt)
    this.validator.taskState(refreshedState)
    return this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, refreshedState),
      event: event(task.taskId, refreshedState.stateRevision, 'authorization-refreshed', enforcementAt, {
        planId: String(plan.planId),
        decisionId: String(decision.decisionId),
        authorizationRequestId: String(authRequest.authorizationRequestId)
      }),
      authorization: { request: authRequest, decision, enforcement }
    })
  }

  async get(taskId: string): Promise<StoredTask | null> {
    return this.store.findById(taskId)
  }
}
