import { fingerprint, stableId } from '../domain/fingerprint.js'
import type { Fingerprint, JsonObject, TaskRequest } from '../domain/types.js'
import { effectKeyForFileReplacement, fileReplacementFrom } from './file-replacement.js'

export function buildFileReplacementPlan(
  taskId: string,
  request: TaskRequest,
  requestFingerprint: Fingerprint,
  basisStateRevision: number,
  now: string,
  planRevision = 1,
  supersedesPlanRef?: JsonObject
): JsonObject {
  const replacement = fileReplacementFrom(request)
  if (!replacement) throw new Error('TaskRequest não declara substituição de arquivo.')
  const { execution } = replacement
  const planId = stableId('plan-file-replacement', `${taskId}:1`)
  const revisionKey = `${planId}:r${planRevision}`
  const actionId = stableId('action-replace-file', revisionKey)
  const effectKey = effectKeyForFileReplacement(taskId, execution)
  const checkpointOutput = stableId('output-checkpoint', revisionKey)
  const readbackOutput = stableId('output-file-readback', revisionKey)
  const steps: JsonObject[] = [
    {
      stepId: stableId('step-replace-file', revisionKey),
      sequence: 1,
      kind: 'execute',
      objective: 'Substituir exatamente o conteúdo declarado do arquivo autorizado, com checkpoint e journal.',
      dependsOnStepRefs: [],
      inputs: [{ kind: 'context-reference', ref: execution.resourceRef }],
      actions: [{
        actionId,
        scope: 'request-resource',
        resourceRef: execution.resourceRef,
        operation: 'filesystem.modify',
        effectPolicy: {
          mode: 'journaled',
          effectKey,
          uncertaintyHandling: 'reconcile-before-retry',
          recovery: {
            mode: 'restore-checkpoint',
            description: 'O conteúdo anterior fica preservado em checkpoint verificável para recuperação manual controlada.'
          }
        }
      }],
      outputs: [{ outputId: checkpointOutput, kind: 'checkpoint', mediaType: 'application/octet-stream' }],
      constraintRefs: request.constraints.map((item) => String(item.id)),
      assumptionRefs: request.context.assumptions.map((item) => String(item.id)),
      criterionRefs: [],
      timeoutMs: Math.min(60_000, request.budget.maxDurationMs),
      checkpointPolicy: 'before-mutation'
    },
    {
      stepId: stableId('step-verify-file', revisionKey),
      sequence: 2,
      kind: 'verify',
      objective: 'Ler novamente o mesmo arquivo e comprovar o digest do conteúdo declarado.',
      dependsOnStepRefs: [stableId('step-replace-file', revisionKey)],
      inputs: [{ kind: 'context-reference', ref: execution.resourceRef }, { kind: 'step-output', ref: checkpointOutput }],
      actions: [{
        actionId: stableId('action-readback-file', revisionKey),
        scope: 'request-resource',
        resourceRef: execution.resourceRef,
        operation: 'filesystem.read',
        effectPolicy: { mode: 'none' }
      }],
      outputs: [{ outputId: readbackOutput, kind: 'evidence', mediaType: 'application/json' }],
      constraintRefs: request.constraints.map((item) => String(item.id)),
      assumptionRefs: request.context.assumptions.map((item) => String(item.id)),
      criterionRefs: request.acceptanceCriteria.map((criterion) => criterion.id),
      timeoutMs: Math.min(30_000, request.budget.maxDurationMs),
      checkpointPolicy: 'none'
    }
  ]
  const strategyFingerprint = fingerprint(steps)
  const base: JsonObject = {
    modelVersion: '1.0',
    planId,
    planRevision,
    ...(planRevision > 1 && supersedesPlanRef ? { supersedesPlanRef } : {}),
    taskBinding: { taskId, requestId: request.requestId, requestFingerprint, basisStateRevision },
    contextBindings: [{
      refId: execution.resourceRef,
      digest: execution.expectedBeforeDigest,
      capturedAt: now,
      source: 'request-digest'
    }],
    createdAt: now,
    mode: 'sequential',
    strategyFingerprint,
    steps,
    criterionCoverage: request.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      verificationStepRefs: [stableId('step-verify-file', revisionKey)],
      evidenceOutputRefs: [readbackOutput]
    })),
    outputBinding: {
      kind: request.expectedOutput.kind,
      mediaType: String(request.expectedOutput.mediaType ?? 'text/plain'),
      destinationRef: execution.resourceRef,
      producerStepRef: stableId('step-verify-file', revisionKey),
      outputRefs: [readbackOutput]
    }
  }
  return { ...base, planFingerprint: fingerprint(base) }
}
