import { fingerprint, sha256, stableId } from '../domain/fingerprint.js'
import type { ClaimedMessage, JsonObject, StoredTask, TaskState } from '../domain/types.js'
import type { TaskStore } from '../ports/task-store.js'
import type { CancellationProjection } from '../ports/execution-control.js'
import { ContractValidator } from '../contracts/validator.js'
import { markCancellationQuiesced, settleCancellation } from './state-builder.js'

export function cancellationRecord(task: StoredTask, state: TaskState, result?: JsonObject): StoredTask {
  return { ...task, state, status: state.lifecycle.state, stateRevision: state.stateRevision,
    executionEpoch: state.executionEpoch, updatedAt: state.updatedAt, ...(result ? { result } : {}) }
}

/** Called only after the executor has stopped or a durable effect fence has been acquired. */
export async function finishCancellation(
  store: TaskStore, validator: ContractValidator, task: StoredTask, now: () => Date,
  projection: CancellationProjection = { evidence: [], artifacts: [], effects: [] }, claim?: ClaimedMessage
): Promise<StoredTask> {
  const at = now().toISOString()
  const cancellation = task.state.cancellation as JsonObject
  const evidenceId = stableId('evidence-cancellation', `${String(cancellation.cancellationId)}:${fingerprint(projection as unknown as JsonObject).value}`)
  const evidence: JsonObject = {
    evidenceId, kind: 'state-readback', capturedAt: at,
    summary: 'Execução encerrada; efeitos reconciliados sem iniciar novas alterações.',
    digest: sha256(JSON.stringify({ taskId: task.taskId, epoch: task.executionEpoch, effects: projection.effects })),
    artifactRefs: [], origin: { kind: 'runtime', id: 'overcore-cancellation-v1' }
  }
  const projectionRefs = [...projection.evidence.map((item) => String(item.evidenceId)), evidenceId]
  if (cancellation.status !== 'quiesced' || projectionRefs.some((ref) => !(task.state.ledger.evidenceRefs as string[]).includes(ref))) {
    const state = markCancellationQuiesced(task.state,
      projectionRefs,
      projection.artifacts.map((item) => String(item.artifactId)), at)
    validator.taskState(state)
    task = await store.compareAndSwap({ expectedRevision: task.stateRevision, next: cancellationRecord(task, state),
      event: { eventId: stableId('event-cancellation-quiesced', `${task.taskId}:${state.stateRevision}`),
        kind: 'cancellation-quiesced', occurredAt: at, payload: { evidence } } })
  }
  const previous = task.state.ledger.resultRefs as JsonObject[]
  const lastResultId = previous.at(-1)?.resultId
  const revision = task.stateRevision + 1
  const resultId = stableId('result-cancelled', `${task.taskId}:${revision}`)
  const startedAt = String((task.state.ledger.attempts as JsonObject[])[0]?.startedAt ?? task.createdAt)
  const result: JsonObject = {
    contractVersion: '1.0', resultId, requestId: task.requestId, taskId: task.taskId,
    requestFingerprint: task.state.requestBinding.requestFingerprint as never,
    stateRef: { stateRevision: revision, transitionId: stableId('transition-cancelled', `${task.taskId}:${revision}:cancellation-settled`),
      emissionSequence: previous.length + 1, ...(typeof lastResultId === 'string' ? { supersedesResultId: lastResultId } : {}) },
    reportedAt: at, status: 'cancelled', summary: 'Cancelamento concluído; efeitos anteriores preservados no relatório.',
    criteria: task.request.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, status: 'not-run', evidenceRefs: [] })),
    evidence: [evidence, ...projection.evidence], artifacts: projection.artifacts, effects: projection.effects,
    execution: { attemptCount: Number(task.state.usage.attemptCount ?? 0),
      maxParallelismObserved: Number(task.state.usage.maxParallelismObserved ?? 0),
      durationMs: Math.max(0, Date.parse(at) - Date.parse(startedAt)), startedAt, finishedAt: at, lastTransitionAt: at },
    cancellation: { code: 'cancel-client-requested', initiatedBy: cancellation.initiatedBy,
      summary: 'Pedido acolhido, execução interrompida e efeitos classificados.', evidenceRefs: [evidenceId] }
  }
  validator.assert('task-result', result)
  const resultFingerprint = fingerprint(result)
  const state = settleCancellation(task.state, resultId, resultFingerprint, evidenceId, at)
  validator.taskState(state)
  return store.compareAndSwap({ expectedRevision: task.stateRevision, next: cancellationRecord(task, state, result),
    event: { eventId: stableId('event-task-cancelled', `${task.taskId}:${state.stateRevision}`), kind: 'task-cancelled',
      occurredAt: at, payload: { resultId, resultFingerprint, evidence } },
    ...(claim ? { completeOutbox: { outboxId: claim.outboxId, claimToken: claim.claimToken } } : {}) })
}
