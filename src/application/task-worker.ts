import { fingerprint, sha256, stableId } from '../domain/fingerprint.js'
import type { InspectionEvidence, JsonObject, StoredTask } from '../domain/types.js'
import type { InspectionExecutor, TaskStore } from '../ports/task-store.js'
import { ContractValidator } from '../contracts/validator.js'
import { beginVerification, succeed } from './state-builder.js'
import type { Clock } from './task-manager.js'
import { systemClock } from './task-manager.js'

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

export class TaskWorker {
  constructor(
    private readonly workerId: string,
    private readonly store: TaskStore,
    private readonly validator: ContractValidator,
    private readonly executor: InspectionExecutor,
    private readonly clock: Clock = systemClock
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
      const repositoryUri = String(claimed.payload.repositoryUri)
      const budget = object(claimed.payload.budget, 'budget da outbox')
      const authorization = object(claimed.payload.runtimeAuthorization, 'autorização de runtime')
      const maxTokens = typeof budget.maxTokens === 'number' ? budget.maxTokens : undefined
      const maxCostUsd = typeof budget.maxCostUsd === 'number' ? budget.maxCostUsd : undefined
      const inspection = await this.executor.execute({
        runId: `${task.taskId}:epoch-${task.executionEpoch}`,
        repositoryUri,
        objective: String(claimed.payload.objective),
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
      }) as unknown as InspectionEvidence
      if (inspection.files.length === 0) throw new Error('A inspeção não encontrou contratos.')
      if (inspection.files.some((file) => !file.readable || !file.rootClosed)) {
        throw new Error('A inspeção encontrou contrato ilegível ou aberto no objeto raiz.')
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
      const result: JsonObject = {
        contractVersion: '1.0',
        resultId,
        requestId: verifyingTask.requestId,
        requestFingerprint: verifyingTask.state.requestBinding.requestFingerprint as never,
        taskId: verifyingTask.taskId,
        stateRef: {
          stateRevision: verifyingTask.stateRevision + 1,
          transitionId,
          emissionSequence: 1
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
          attemptCount: 1,
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
}
