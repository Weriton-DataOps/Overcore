import { fingerprint, sha256, stableId } from '../domain/fingerprint.js'
import type { ClaimedMessage, ExecutionReceipt, InspectionEvidence, JsonObject, StoredTask } from '../domain/types.js'
import { ExecutionFailure, type FileReplacementExecutor, type InspectionExecutor, type TaskStore } from '../ports/task-store.js'
import { ContractValidator } from '../contracts/validator.js'
import { beginVerification, failTask, scheduleRetry, succeed } from './state-builder.js'
import type { Clock } from './task-manager.js'
import { systemClock } from './task-manager.js'
import { EffectStateUncertainError, type FileMutationResult } from './file-effect-harness.js'

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

function evidenceDocuments(task: StoredTask, inspection: InspectionEvidence) {
  const capturedAt = inspection.capturedAt
  const readableId = stableId('evidence-json-readable', `${task.taskId}:${task.executionEpoch}`)
  const closedId = stableId('evidence-contract-closed', `${task.taskId}:${task.executionEpoch}`)
  const readablePayload = {
    schemaCount: inspection.schemaCount,
    readable: inspection.files.map((file) => ({ name: file.name, readable: file.readable }))
  }
  const closedPayload = {
    schemaCount: inspection.schemaCount,
    rootClosed: inspection.files.map((file) => ({ name: file.name, rootClosed: file.rootClosed }))
  }
  const values: JsonObject[] = [
    {
      evidenceId: readableId,
      kind: 'schema-validation',
      capturedAt,
      summary: `${inspection.schemaCount} contratos foram analisados sintaticamente.`,
      digest: sha256(JSON.stringify(readablePayload)),
      artifactRefs: [],
      origin: { kind: 'executor', id: 'overcore-readonly-inspector-v1' }
    },
    {
      evidenceId: closedId,
      kind: 'inspection',
      capturedAt,
      summary: `${inspection.schemaCount} contratos foram verificados quanto ao fechamento do objeto raiz.`,
      digest: sha256(JSON.stringify(closedPayload)),
      artifactRefs: [],
      origin: { kind: 'executor', id: 'overcore-readonly-inspector-v1' }
    }
  ]
  let agentRuntimeId: string | undefined
  if (inspection.agentRuntime) {
    agentRuntimeId = stableId('evidence-agent-runtime', `${task.taskId}:${task.executionEpoch}`)
    values.push({
      evidenceId: agentRuntimeId,
      kind: 'inspection',
      capturedAt,
      summary: `Claude Agent SDK ${inspection.agentRuntime.sdkVersion} executou por login OAuth em ${inspection.agentRuntime.turns} turno(s), com ${inspection.agentRuntime.permissionDenials} negação(ões) de ferramenta.`,
      digest: inspection.agentRuntime.outputDigest,
      artifactRefs: [],
      origin: { kind: 'executor', id: 'anthropic-agent-sdk-runtime-v1' }
    })
  }
  return {
    readableId,
    closedId,
    agentRuntimeId,
    values
  }
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`)
  return value as JsonObject
}

const MAX_DELIVERY_ATTEMPTS_PER_STRATEGY = 2
const OUTBOX_LEASE_MS = 30_000
const OUTBOX_HEARTBEAT_MS = 10_000

function inspectionFrom(value: unknown): InspectionEvidence {
  const found = object(value, 'resultado da inspecao') as unknown as InspectionEvidence
  if (!Array.isArray(found.files) || typeof found.schemaCount !== 'number' || typeof found.capturedAt !== 'string') {
    throw new ExecutionFailure(
      'executor-invalid-result',
      'internal',
      false,
      'O executor devolveu um resultado de inspecao incompleto.'
    )
  }
  return found
}

function fileMutationFrom(value: unknown): FileMutationResult {
  const found = object(value, 'resultado da substituição de arquivo')
  const projection = object(found.taskResultProjection, 'projeção do resultado da substituição')
  if (!Array.isArray(projection.evidence) || !Array.isArray(projection.artifacts) || !Array.isArray(projection.effects)) {
    throw new ExecutionFailure(
      'file-replacement-invalid-result',
      'internal',
      false,
      'O executor de substituição não devolveu evidências, artefatos e efeitos completos.'
    )
  }
  if (typeof projection.checkpointArtifactRef !== 'string' || projection.checkpointArtifactRef.length === 0) {
    throw new ExecutionFailure('file-replacement-invalid-result', 'internal', false, 'O executor não devolveu o checkpoint.')
  }
  return found as unknown as FileMutationResult
}

function classifyExecutionFailure(error: unknown): ExecutionFailure {
  if (error instanceof ExecutionFailure) return error
  if (error instanceof EffectStateUncertainError) {
    return new ExecutionFailure('effect-state-uncertain', 'verification', false, error.message, undefined, true)
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOENT|nao existe|nao encontrou contratos/i.test(message)) {
    return new ExecutionFailure('inspection-resource-not-found', 'resource', false, message)
  }
  if (/precondi[çc][ãa]o declarada|n[aã]o corresponde [àa] precondi/i.test(message)) {
    return new ExecutionFailure('effect-precondition-diverged', 'verification', false, message)
  }
  if (/ileg.vel|objeto raiz|JSON|contrato/i.test(message)) {
    return new ExecutionFailure('inspection-verification-failed', 'verification', false, message)
  }
  return new ExecutionFailure('executor-interrupted', 'internal', true, message, 5_000)
}

function failureEvidence(task: StoredTask, failure: ExecutionFailure, at: string): JsonObject {
  const details = {
    code: failure.code,
    category: failure.category,
    retryable: failure.retryable,
    message: failure.message,
    executionEpoch: task.executionEpoch
  }
  return {
    evidenceId: stableId('evidence-execution-failure', `${task.taskId}:${task.executionEpoch}:${sha256(JSON.stringify(details))}`),
    kind: 'test-result',
    capturedAt: at,
    summary: failure.message.slice(0, 2000),
    digest: sha256(JSON.stringify(details)),
    artifactRefs: [],
    origin: { kind: 'runtime', id: 'overcore-task-worker-v1' }
  }
}

export class TaskWorker {
  constructor(
    private readonly workerId: string,
    private readonly store: TaskStore,
    private readonly validator: ContractValidator,
    private readonly executor: InspectionExecutor,
    private readonly clock: Clock = systemClock,
    private readonly fileReplacementExecutor?: FileReplacementExecutor
  ) {}

  async runOnce(): Promise<StoredTask | null> {
    const claimed = await this.store.claimOutbox(this.workerId, 30_000, this.clock.now())
    if (!claimed) return null
    try {
      const task = await this.store.findById(claimed.taskId)
      if (!task) throw new Error(`Tarefa ${claimed.taskId} da outbox não existe.`)
      if (task.status !== 'running' && task.status !== 'verifying') {
        throw new Error(`Tarefa ${task.taskId} não pode consumir inspeção em ${task.status}.`)
      }
      if (claimed.kind === 'execute-file-replacement') {
        return this.runFileReplacement(task, claimed)
      }
      if (claimed.kind !== 'execute-inspection') throw new Error(`Mensagem de execução desconhecida: ${claimed.kind}.`)
      const repositoryUri = String(claimed.payload.repositoryUri)
      const budget = object(claimed.payload.budget, 'budget da outbox')
      const authorization = object(claimed.payload.runtimeAuthorization, 'autorização de runtime')
      const maxTokens = typeof budget.maxTokens === 'number' ? budget.maxTokens : undefined
      const maxCostUsd = typeof budget.maxCostUsd === 'number' ? budget.maxCostUsd : undefined
      let inspection: InspectionEvidence
      const persistedReceipt = await this.store.findExecutionReceipt(claimed.outboxId)
      if (persistedReceipt) {
        this.assertReceipt(persistedReceipt, task, claimed.outboxId)
        if (persistedReceipt.payload.kind !== 'inspection-completed') {
          throw new Error('Recibo de execução não pertence a uma inspeção.')
        }
        inspection = inspectionFrom(persistedReceipt.payload.inspection)
      } else {
        try {
          inspection = inspectionFrom(await this.executeWithLeaseHeartbeat(claimed, {
            runId: `${task.taskId}:epoch-${task.executionEpoch}`,
            repositoryUri,
            objective: String(claimed.payload.objective),
            strategyRevision: Number(claimed.payload.strategyRevision ?? 1),
            timeoutMs: Number(budget.maxDurationMs),
            authorization: {
              enforcementId: String(authorization.enforcementId),
              enforcementFingerprint: String(authorization.enforcementFingerprint),
              expiresAt: String(authorization.expiresAt),
              operations: Array.isArray(authorization.operations) ? authorization.operations.map(String) : [],
              requiredControls: Array.isArray(authorization.requiredControls)
                ? authorization.requiredControls.map(String)
                : []
            },
            ...(maxTokens === undefined ? {} : { maxTokens }),
            ...(maxCostUsd === undefined ? {} : { maxCostUsd })
          }))
        } catch (error) {
          return this.handleExecutionFailure(task, claimed, classifyExecutionFailure(error))
        }
        const receiptPayload: JsonObject = { kind: 'inspection-completed', inspection: inspection as never }
        await this.store.saveExecutionReceipt({
          receiptId: stableId('execution-receipt', claimed.outboxId),
          outboxId: claimed.outboxId,
          taskId: task.taskId,
          executionEpoch: task.executionEpoch,
          payload: receiptPayload,
          payloadFingerprint: fingerprint(receiptPayload),
          recordedAt: this.clock.now().toISOString()
        }, claimed.claimToken, this.clock.now())
      }
      try {
        if (inspection.files.length === 0) throw new Error('A inspecao nao encontrou contratos.')
        if (inspection.files.some((file) => !file.readable || !file.rootClosed)) {
          throw new Error('A inspecao encontrou contrato ilegivel ou aberto no objeto raiz.')
        }
      } catch (error) {
        return this.handleExecutionFailure(task, claimed, classifyExecutionFailure(error))
      }
      const evidence = evidenceDocuments(task, inspection)
      const evidenceRefs = [evidence.readableId, evidence.closedId]
      if (evidence.agentRuntimeId) evidenceRefs.push(evidence.agentRuntimeId)

      let verifyingTask = task
      if (task.status === 'running') {
        const verifyingAt = this.clock.now().toISOString()
        const runtimeBinding: JsonObject | undefined = inspection.agentRuntime ? {
          engine: inspection.agentRuntime.engine,
          sdkVersion: inspection.agentRuntime.sdkVersion,
          authSource: inspection.agentRuntime.authSource,
          sessionId: inspection.agentRuntime.sessionId,
          model: inspection.agentRuntime.model,
          inputTokens: inspection.agentRuntime.inputTokens,
          outputTokens: inspection.agentRuntime.outputTokens,
          estimatedCostUsd: inspection.agentRuntime.estimatedCostUsd,
          permissionDenials: inspection.agentRuntime.permissionDenials,
          eventCount: inspection.agentRuntime.eventCount,
          outputDigest: inspection.agentRuntime.outputDigest
        } : undefined
        const verifyingState = beginVerification(task.state, evidenceRefs, verifyingAt, runtimeBinding)
        this.validator.taskState(verifyingState)
        verifyingTask = await this.store.compareAndSwap({
          expectedRevision: task.stateRevision,
          next: record(task, verifyingState),
          event: {
            eventId: stableId('event-verifying', `${task.taskId}:${verifyingState.stateRevision}`),
            kind: 'verification-started',
            occurredAt: verifyingAt,
            payload: {
              evidenceRefs,
              ...(inspection.agentRuntime ? {
                agentRuntime: {
                  engine: inspection.agentRuntime.engine,
                  sessionId: inspection.agentRuntime.sessionId,
                  authSource: inspection.agentRuntime.authSource
                }
              } : {})
            }
          }
        })
      }

      const finishedAt = this.clock.now().toISOString()
      const resultId = stableId('result-inspection', `${task.taskId}:${verifyingTask.stateRevision + 1}`)
      const transitionId = stableId(
        'transition-succeeded',
        `${task.taskId}:${verifyingTask.stateRevision + 1}:verification-passed`
      )
      const criterionEvidence = new Map<string, string[]>()
      for (const criterion of verifyingTask.request.acceptanceCriteria) {
        criterionEvidence.set(
          criterion.id,
          [criterion.verification.method === 'schema' ? evidence.closedId : evidence.readableId]
        )
      }
      const startedAt = String((verifyingTask.state.ledger.attempts as JsonObject[])[0]?.startedAt ?? verifyingTask.createdAt)
      const previousResultRefs = Array.isArray(verifyingTask.state.ledger.resultRefs)
        ? verifyingTask.state.ledger.resultRefs as JsonObject[]
        : []
      const previousResultId = previousResultRefs.at(-1)?.resultId
      const result: JsonObject = {
        contractVersion: '1.0',
        resultId,
        requestId: verifyingTask.requestId,
        requestFingerprint: verifyingTask.state.requestBinding.requestFingerprint as never,
        taskId: verifyingTask.taskId,
        stateRef: {
          stateRevision: verifyingTask.stateRevision + 1,
          transitionId,
          emissionSequence: previousResultRefs.length + 1,
          ...(typeof previousResultId === 'string' ? { supersedesResultId: previousResultId } : {})
        },
        reportedAt: finishedAt,
        status: 'succeeded',
        summary: `${inspection.schemaCount} contratos foram lidos e confirmados como fechados no objeto raiz.`,
        criteria: verifyingTask.request.acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.id,
          status: 'passed',
          evidenceRefs: criterionEvidence.get(criterion.id) ?? []
        })),
        evidence: evidence.values,
        artifacts: [],
        effects: [],
        execution: {
          attemptCount: Number(verifyingTask.state.usage.attemptCount ?? 1),
          maxParallelismObserved: 1,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
          startedAt,
          finishedAt,
          lastTransitionAt: finishedAt,
          ...(inspection.agentRuntime ? {
            tokens: inspection.agentRuntime.inputTokens + inspection.agentRuntime.outputTokens,
            costUsd: inspection.agentRuntime.estimatedCostUsd
          } : {})
        }
      }
      this.validator.assert('task-result', result)
      const resultFingerprint = fingerprint(result)
      const succeededState = succeed(
        verifyingTask.state,
        resultId,
        criterionEvidence,
        resultFingerprint,
        finishedAt
      )
      this.validator.taskState(succeededState)
      const completed = await this.store.compareAndSwap({
        expectedRevision: verifyingTask.stateRevision,
        next: record(verifyingTask, succeededState, result),
        event: {
          eventId: stableId('event-succeeded', `${task.taskId}:${succeededState.stateRevision}`),
          kind: 'task-succeeded',
          occurredAt: finishedAt,
          payload: { resultId, resultFingerprint }
        },
        completeOutbox: { outboxId: claimed.outboxId, claimToken: claimed.claimToken }
      })
      return completed
    } catch (error) {
      const message = error instanceof Error ? `${error.name}:${error.message}` : String(error)
      await this.store.releaseOutbox(
        claimed.outboxId,
        claimed.claimToken,
        sha256(message),
        new Date(this.clock.now().getTime() + 5_000)
      )
      throw error
    }
  }

  private assertReceipt(receipt: ExecutionReceipt, task: StoredTask, outboxId: string): void {
    if (receipt.outboxId !== outboxId || receipt.taskId !== task.taskId) {
      throw new Error('Recibo de execucao pertence a outra tarefa ou mensagem.')
    }
    if (receipt.executionEpoch !== task.executionEpoch) {
      throw new Error('Recibo de execucao pertence a outro executionEpoch.')
    }
    if (fingerprint(receipt.payload).value !== receipt.payloadFingerprint.value) {
      throw new Error('Fingerprint do recibo de execucao nao corresponde ao payload persistido.')
    }
  }

  private async runFileReplacement(task: StoredTask, claimed: ClaimedMessage): Promise<StoredTask> {
    const execution = object(claimed.payload.execution, 'execução de arquivo da outbox')
    const authorization = object(claimed.payload.runtimeAuthorization, 'autorização de runtime')
    const authorizationRequest = object(authorization.authorizationRequest, 'pedido original de autorização')
    let mutation: FileMutationResult
    const persistedReceipt = await this.store.findExecutionReceipt(claimed.outboxId)
    if (persistedReceipt) {
      this.assertReceipt(persistedReceipt, task, claimed.outboxId)
      if (persistedReceipt.payload.kind !== 'file-replacement-completed') {
        throw new Error('Recibo de execução não pertence a uma substituição de arquivo.')
      }
      mutation = fileMutationFrom(persistedReceipt.payload.mutation)
    } else {
      if (!this.fileReplacementExecutor) {
        return this.handleExecutionFailure(task, claimed, new ExecutionFailure(
          'file-replacement-executor-unavailable',
          'internal',
          false,
          'O runtime não recebeu o executor de substituição de arquivo.'
        ))
      }
      try {
        mutation = fileMutationFrom(await this.executeFileReplacementWithLeaseHeartbeat(claimed, {
          taskId: task.taskId,
          effectKey: String(claimed.payload.effectKey),
          actionId: String(claimed.payload.actionId),
          resourceRef: String(execution.resourceRef),
          targetUri: String(claimed.payload.targetUri),
          desiredContent: String(execution.desiredContent),
          expectedBeforeDigest: String(execution.expectedBeforeDigest) as `sha256:${string}`,
          authorization: {
            enforcementId: String(authorization.enforcementId),
            expiresAt: String(authorization.expiresAt),
            operations: Array.isArray(authorization.operations) ? authorization.operations.map(String) : [],
            requiredControls: Array.isArray(authorization.requiredControls)
              ? authorization.requiredControls.map(String)
              : [],
            authorizationRequest
          }
        }))
      } catch (error) {
        return this.handleExecutionFailure(task, claimed, classifyExecutionFailure(error))
      }
      const receiptPayload: JsonObject = {
        kind: 'file-replacement-completed',
        mutation: mutation as unknown as JsonObject
      }
      await this.store.saveExecutionReceipt({
        receiptId: stableId('execution-receipt', claimed.outboxId),
        outboxId: claimed.outboxId,
        taskId: task.taskId,
        executionEpoch: task.executionEpoch,
        payload: receiptPayload,
        payloadFingerprint: fingerprint(receiptPayload),
        recordedAt: this.clock.now().toISOString()
      }, claimed.claimToken, this.clock.now())
    }

    const projection = mutation.taskResultProjection
    const evidence = projection.evidence as JsonObject[]
    const evidenceRefs = evidence.map((item) => String(item.evidenceId)).filter(Boolean)
    if (evidenceRefs.length === 0) {
      return this.handleExecutionFailure(task, claimed, new ExecutionFailure(
        'file-replacement-missing-readback', 'verification', false, 'A substituição não produziu evidência de leitura posterior.'
      ))
    }
    let verifyingTask = task
    if (task.status === 'running') {
      const verifyingAt = this.clock.now().toISOString()
      const verifyingState = beginVerification(task.state, evidenceRefs, verifyingAt)
      this.validator.taskState(verifyingState)
      verifyingTask = await this.store.compareAndSwap({
        expectedRevision: task.stateRevision,
        next: record(task, verifyingState),
        event: {
          eventId: stableId('event-file-verifying', `${task.taskId}:${verifyingState.stateRevision}`),
          kind: 'verification-started',
          occurredAt: verifyingAt,
          payload: { evidenceRefs, effectKey: mutation.journal.effectKey }
        }
      })
    }
    const finishedAt = this.clock.now().toISOString()
    const resultId = stableId('result-file-replacement', `${task.taskId}:${verifyingTask.stateRevision + 1}`)
    const transitionId = stableId('transition-succeeded', `${task.taskId}:${verifyingTask.stateRevision + 1}:file-readback-passed`)
    const criterionEvidence = new Map<string, string[]>()
    for (const criterion of verifyingTask.request.acceptanceCriteria) criterionEvidence.set(criterion.id, evidenceRefs)
    const startedAt = String((verifyingTask.state.ledger.attempts as JsonObject[])[0]?.startedAt ?? verifyingTask.createdAt)
    const previousResultRefs = Array.isArray(verifyingTask.state.ledger.resultRefs)
      ? verifyingTask.state.ledger.resultRefs as JsonObject[]
      : []
    const previousResultId = previousResultRefs.at(-1)?.resultId
    const result: JsonObject = {
      contractVersion: '1.0',
      resultId,
      requestId: verifyingTask.requestId,
      requestFingerprint: verifyingTask.state.requestBinding.requestFingerprint as never,
      taskId: verifyingTask.taskId,
      stateRef: {
        stateRevision: verifyingTask.stateRevision + 1,
        transitionId,
        emissionSequence: previousResultRefs.length + 1,
        ...(typeof previousResultId === 'string' ? { supersedesResultId: previousResultId } : {})
      },
      reportedAt: finishedAt,
      status: 'succeeded',
      summary: mutation.wrote
        ? 'O arquivo autorizado foi substituído uma vez, recebeu checkpoint e foi confirmado por leitura posterior.'
        : 'O arquivo já possuía o conteúdo declarado; o estado foi confirmado sem nova escrita.',
      criteria: verifyingTask.request.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.id,
        status: 'passed',
        evidenceRefs: criterionEvidence.get(criterion.id) ?? []
      })),
      evidence,
      artifacts: projection.artifacts,
      effects: projection.effects,
      execution: {
        attemptCount: Number(verifyingTask.state.usage.attemptCount ?? 1),
        maxParallelismObserved: 1,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        startedAt,
        finishedAt,
        lastTransitionAt: finishedAt,
        checkpointArtifactRef: projection.checkpointArtifactRef
      }
    }
    this.validator.assert('task-result', result)
    const resultFingerprint = fingerprint(result)
    const succeededState = succeed(verifyingTask.state, resultId, criterionEvidence, resultFingerprint, finishedAt)
    this.validator.taskState(succeededState)
    return this.store.compareAndSwap({
      expectedRevision: verifyingTask.stateRevision,
      next: record(verifyingTask, succeededState, result),
      event: {
        eventId: stableId('event-file-succeeded', `${task.taskId}:${succeededState.stateRevision}`),
        kind: 'task-succeeded',
        occurredAt: finishedAt,
        payload: { resultId, resultFingerprint, effectKey: mutation.journal.effectKey }
      },
      completeOutbox: { outboxId: claimed.outboxId, claimToken: claimed.claimToken }
    })
  }

  private async executeFileReplacementWithLeaseHeartbeat(
    claimed: ClaimedMessage,
    input: Parameters<FileReplacementExecutor['execute']>[0]
  ): Promise<JsonObject> {
    if (!this.fileReplacementExecutor) throw new Error('Executor de substituição de arquivo indisponível.')
    await this.store.extendOutboxLease(claimed.outboxId, claimed.claimToken, OUTBOX_LEASE_MS, this.clock.now())
    return this.fileReplacementExecutor.execute(input)
  }

  private async executeWithLeaseHeartbeat(
    claimed: ClaimedMessage,
    input: Parameters<InspectionExecutor['execute']>[0]
  ): Promise<JsonObject> {
    await this.store.extendOutboxLease(
      claimed.outboxId,
      claimed.claimToken,
      OUTBOX_LEASE_MS,
      this.clock.now()
    )
    let heartbeatError: unknown
    let renewing = false
    const heartbeat = setInterval(() => {
      if (renewing || heartbeatError) return
      renewing = true
      void this.store.extendOutboxLease(
        claimed.outboxId,
        claimed.claimToken,
        OUTBOX_LEASE_MS,
        this.clock.now()
      ).catch((error: unknown) => {
        heartbeatError = error
      }).finally(() => {
        renewing = false
      })
    }, OUTBOX_HEARTBEAT_MS)
    heartbeat.unref()
    try {
      const result = await this.executor.execute(input)
      if (heartbeatError) throw heartbeatError
      return result
    } finally {
      clearInterval(heartbeat)
    }
  }

  private async handleExecutionFailure(
    task: StoredTask,
    claimed: ClaimedMessage,
    failure: ExecutionFailure
  ): Promise<StoredTask> {
    const delayMs = Math.max(1_000, failure.retryAfterMs ?? 5_000)
    if (failure.retryable && claimed.attempts < MAX_DELIVERY_ATTEMPTS_PER_STRATEGY) {
      await this.store.releaseOutbox(
        claimed.outboxId,
        claimed.claimToken,
        sha256(`${failure.code}:${failure.message}`),
        new Date(this.clock.now().getTime() + delayMs)
      )
      return (await this.store.findById(task.taskId)) ?? task
    }

    const failedAt = this.clock.now().toISOString()
    const evidence = failureEvidence(task, failure, failedAt)
    const evidenceId = String(evidence.evidenceId)
    const attemptCount = Number(task.state.usage.attemptCount ?? 1)
    if (failure.retryable && attemptCount < task.request.budget.maxAttempts && !failure.effectUncertain) {
      const retryState = scheduleRetry(task.state, evidenceId, failedAt)
      this.validator.taskState(retryState)
      return this.store.compareAndSwap({
        expectedRevision: task.stateRevision,
        next: record(task, retryState),
        event: {
          eventId: stableId('event-retry-scheduled', `${task.taskId}:${retryState.stateRevision}`),
          kind: 'retry-scheduled',
          occurredAt: failedAt,
          payload: {
            failure: evidence,
            previousExecutionEpoch: task.executionEpoch,
            nextExecutionEpoch: retryState.executionEpoch
          }
        },
        completeOutbox: { outboxId: claimed.outboxId, claimToken: claimed.claimToken }
      })
    }

    const previousResultRefs = Array.isArray(task.state.ledger.resultRefs)
      ? task.state.ledger.resultRefs as JsonObject[]
      : []
    const previousResultId = previousResultRefs.at(-1)?.resultId
    const resultId = stableId('result-execution-failed', `${task.taskId}:${task.stateRevision + 1}`)
    const transitionId = stableId(
      'transition-failed',
      `${task.taskId}:${task.stateRevision + 1}:recovery-exhausted`
    )
    const attempts = Array.isArray(task.state.ledger.attempts)
      ? task.state.ledger.attempts as JsonObject[]
      : []
    const startedAt = String(attempts[0]?.startedAt ?? task.createdAt)
    const summary = failure.effectUncertain
      ? 'A execucao terminou com efeito incerto e nao pode ser repetida sem reconciliacao.'
      : failure.retryable
        ? `A recuperacao esgotou ${task.request.budget.maxAttempts} tentativa(s): ${failure.message}`
        : `A execucao terminou com falha nao recuperavel: ${failure.message}`
    const result: JsonObject = {
      contractVersion: '1.0',
      resultId,
      requestId: task.requestId,
      requestFingerprint: task.state.requestBinding.requestFingerprint as never,
      taskId: task.taskId,
      stateRef: {
        stateRevision: task.stateRevision + 1,
        transitionId,
        emissionSequence: previousResultRefs.length + 1,
        ...(typeof previousResultId === 'string' ? { supersedesResultId: previousResultId } : {})
      },
      reportedAt: failedAt,
      status: 'failed',
      summary: summary.slice(0, 4000),
      criteria: task.request.acceptanceCriteria.map((criterion, index) => ({
        criterionId: criterion.id,
        status: index === 0 ? 'failed' : 'not-run',
        evidenceRefs: index === 0 ? [evidenceId] : []
      })),
      evidence: [evidence],
      artifacts: [],
      effects: [],
      execution: {
        attemptCount,
        maxParallelismObserved: Number(task.state.usage.maxParallelismObserved ?? 1),
        durationMs: Math.max(0, Date.parse(failedAt) - Date.parse(startedAt)),
        startedAt,
        finishedAt: failedAt,
        lastTransitionAt: failedAt,
        ...(typeof task.state.usage.tokens === 'number' ? { tokens: task.state.usage.tokens } : {}),
        ...(typeof task.state.usage.costUsd === 'number' ? { costUsd: task.state.usage.costUsd } : {})
      },
      failure: {
        code: failure.effectUncertain ? 'execution-effect-uncertain' : failure.code,
        category: failure.effectUncertain ? 'external' : failure.category,
        retryable: false,
        summary: summary.slice(0, 2000),
        evidenceRefs: [evidenceId]
      }
    }
    this.validator.assert('task-result', result)
    const resultFingerprint = fingerprint(result)
    const failedState = failTask(task.state, resultId, resultFingerprint, evidenceId, failedAt)
    this.validator.taskState(failedState)
    return this.store.compareAndSwap({
      expectedRevision: task.stateRevision,
      next: record(task, failedState, result),
      event: {
        eventId: stableId('event-task-failed', `${task.taskId}:${failedState.stateRevision}`),
        kind: 'task-failed',
        occurredAt: failedAt,
        payload: { failure: evidence, resultId, resultFingerprint }
      },
      completeOutbox: { outboxId: claimed.outboxId, claimToken: claimed.claimToken }
    })
  }
}
