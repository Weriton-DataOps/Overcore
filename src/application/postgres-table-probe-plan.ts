import { fingerprint, stableId } from '../domain/fingerprint.js'
import type { Fingerprint, JsonObject, TaskRequest } from '../domain/types.js'
import { effectKeyForPostgresTableProbe, postgresTableProbeFrom } from './postgres-table-probe.js'

export function buildPostgresTableProbePlan(
  taskId: string,
  request: TaskRequest,
  requestFingerprint: Fingerprint,
  basisStateRevision: number,
  now: string,
  planRevision = 1,
  supersedesPlanRef?: JsonObject
): JsonObject {
  const probe = postgresTableProbeFrom(request)
  if (!probe) throw new Error('TaskRequest não declara sonda PostgreSQL.')
  const { execution } = probe
  const planId = stableId('plan-postgres-table-probe', `${taskId}:1`)
  const revisionKey = `${planId}:r${planRevision}`
  const actionId = stableId('action-postgres-table-probe', revisionKey)
  const effectKey = effectKeyForPostgresTableProbe(taskId, execution)
  const evidenceOutput = stableId('output-postgres-table-probe', revisionKey)
  const executeStep = stableId('step-postgres-table-probe', revisionKey)
  const verifyStep = stableId('step-verify-postgres-table-probe', revisionKey)
  const steps: JsonObject[] = [
    {
      stepId: executeStep,
      sequence: 1,
      kind: 'execute',
      objective: 'Criar e remover, na mesma transação, a tabela temporária PostgreSQL declarada.',
      dependsOnStepRefs: [],
      inputs: [{ kind: 'context-reference', ref: execution.resourceRef }],
      actions: [{
        actionId,
        scope: 'request-resource',
        resourceRef: execution.resourceRef,
        operation: 'database.schema.modify',
        effectPolicy: {
          mode: 'journaled',
          effectKey,
          uncertaintyHandling: 'reconcile-before-retry',
          recovery: {
            mode: 'retain-and-report',
            description: 'A transação local é revertida se não concluir; qualquer presença inesperada da tabela é mantida visível para reconciliação, nunca removida por retry cego.'
          }
        }
      }],
      outputs: [{ outputId: evidenceOutput, kind: 'evidence', mediaType: 'application/json' }],
      constraintRefs: request.constraints.map((item) => String(item.id)),
      assumptionRefs: request.context.assumptions.map((item) => String(item.id)),
      criterionRefs: [],
      timeoutMs: Math.min(60_000, request.budget.maxDurationMs),
      checkpointPolicy: 'before-mutation'
    },
    {
      stepId: verifyStep,
      sequence: 2,
      kind: 'verify',
      objective: 'Confirmar que a tabela temporária existiu durante a transação e está ausente após o commit.',
      dependsOnStepRefs: [executeStep],
      inputs: [{ kind: 'context-reference', ref: execution.resourceRef }, { kind: 'step-output', ref: evidenceOutput }],
      actions: [{
        actionId: stableId('action-readback-postgres-table-probe', revisionKey),
        scope: 'request-resource',
        resourceRef: execution.resourceRef,
        operation: 'database.schema.read',
        effectPolicy: { mode: 'none' }
      }],
      outputs: [{ outputId: stableId('output-postgres-table-absence', revisionKey), kind: 'evidence', mediaType: 'application/json' }],
      constraintRefs: request.constraints.map((item) => String(item.id)),
      assumptionRefs: request.context.assumptions.map((item) => String(item.id)),
      criterionRefs: request.acceptanceCriteria.map((criterion) => criterion.id),
      timeoutMs: Math.min(30_000, request.budget.maxDurationMs),
      checkpointPolicy: 'none'
    }
  ]
  const base: JsonObject = {
    modelVersion: '1.0', planId, planRevision,
    ...(planRevision > 1 && supersedesPlanRef ? { supersedesPlanRef } : {}),
    taskBinding: { taskId, requestId: request.requestId, requestFingerprint, basisStateRevision },
    contextBindings: [{
      refId: execution.resourceRef,
      digest: fingerprint({ databaseName: execution.databaseName, tableName: execution.tableName }).value,
      capturedAt: now,
      source: 'request-digest'
    }],
    createdAt: now, mode: 'sequential', strategyFingerprint: fingerprint(steps), steps,
    criterionCoverage: request.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, verificationStepRefs: [verifyStep], evidenceOutputRefs: [evidenceOutput] })),
    outputBinding: { kind: request.expectedOutput.kind, mediaType: String(request.expectedOutput.mediaType ?? 'application/json'), destinationRef: execution.resourceRef, producerStepRef: verifyStep, outputRefs: [evidenceOutput] }
  }
  return { ...base, planFingerprint: fingerprint(base) }
}
