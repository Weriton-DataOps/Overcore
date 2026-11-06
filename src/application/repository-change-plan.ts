import { fingerprint, sha256, stableId } from '../domain/fingerprint.js'
import type { Fingerprint, JsonObject, TaskRequest } from '../domain/types.js'
import { effectKeyForRepositoryChange, repositoryChangeFrom } from './repository-change.js'

/**
 * Plano da ADR-022 em quatro passos: bancada, edição, medição e efeito.
 *
 * Só o último toca o recurso do pedido com efeito; a edição é runtime-internal
 * porque o worktree é diretório operacional do Overcore.
 */
export function buildRepositoryChangePlan(
  taskId: string,
  request: TaskRequest,
  requestFingerprint: Fingerprint,
  basisStateRevision: number,
  now: string,
  planRevision = 1,
  supersedesPlanRef?: JsonObject
): JsonObject {
  const change = repositoryChangeFrom(request)
  if (!change) throw new Error('TaskRequest não declara mudança de repositório.')
  const { execution, repositoryUri } = change
  const resourceRef = execution.resourceRef
  const planId = stableId('plan-repository-change', `${taskId}:1`)
  const revisionKey = `${planId}:r${planRevision}`
  const prepareStep = stableId('step-prepare-workbench', revisionKey)
  const editStep = stableId('step-edit-workbench', revisionKey)
  const verifyStep = stableId('step-measure-verify', revisionKey)
  const deliverStep = stableId('step-create-branch', revisionKey)
  const workbenchOutput = stableId('output-workbench', revisionKey)
  const patchOutput = stableId('output-patch', revisionKey)
  const evidenceOutput = stableId('output-measurement', revisionKey)
  const receiptOutput = stableId('output-branch-receipt', revisionKey)
  const constraintRefs = request.constraints.map((item) => String(item.id))
  const assumptionRefs = request.context.assumptions.map((item) => String(item.id))
  const timeoutMs = Math.max(1, request.budget.maxDurationMs)
  const common = { constraintRefs, assumptionRefs }
  const steps: JsonObject[] = [
    {
      stepId: prepareStep,
      sequence: 1,
      kind: 'prepare',
      objective: `Criar worktree destacado no commit ${execution.baseCommit}, fora do repositório do proprietário.`,
      dependsOnStepRefs: [],
      inputs: [{ kind: 'context-reference', ref: resourceRef }],
      actions: [{
        actionId: stableId('action-read-repository', revisionKey),
        scope: 'request-resource',
        resourceRef,
        operation: 'repository.read',
        effectPolicy: { mode: 'none' }
      }],
      outputs: [{ outputId: workbenchOutput, kind: 'observation', mediaType: 'application/json' }],
      ...common,
      criterionRefs: [],
      timeoutMs: Math.min(120_000, timeoutMs),
      checkpointPolicy: 'none'
    },
    {
      stepId: editStep,
      sequence: 2,
      kind: 'execute',
      objective: 'Editar somente arquivos de texto dentro do escopo declarado, na bancada, conforme as instruções congeladas.',
      dependsOnStepRefs: [prepareStep],
      inputs: [{ kind: 'step-output', ref: workbenchOutput }],
      actions: [{
        actionId: stableId('action-edit-workbench', revisionKey),
        scope: 'runtime-internal',
        operation: 'repository.worktree.modify',
        effectPolicy: { mode: 'none' }
      }],
      outputs: [{ outputId: patchOutput, kind: 'artifact', mediaType: 'text/x-diff' }],
      ...common,
      criterionRefs: [],
      timeoutMs,
      checkpointPolicy: 'none'
    },
    {
      stepId: verifyStep,
      sequence: 3,
      kind: 'verify',
      objective: execution.verification
        ? 'Medir o diff contra o commit base, aplicar escopo e limites e executar a verificação declarada sem shell.'
        : 'Medir o diff contra o commit base e aplicar escopo e limites.',
      dependsOnStepRefs: [editStep],
      inputs: [{ kind: 'step-output', ref: patchOutput }],
      actions: [
        {
          actionId: stableId('action-measure-diff', revisionKey),
          scope: 'request-resource',
          resourceRef,
          operation: 'repository.read',
          effectPolicy: { mode: 'none' }
        },
        ...(execution.verification ? [{
          actionId: stableId('action-run-verification', revisionKey),
          scope: 'request-resource',
          resourceRef,
          operation: 'process.execute',
          effectPolicy: { mode: 'none' }
        }] : [])
      ],
      outputs: [{ outputId: evidenceOutput, kind: 'evidence', mediaType: 'application/json' }],
      ...common,
      criterionRefs: request.acceptanceCriteria.map((criterion) => criterion.id),
      timeoutMs: Math.min(timeoutMs, (execution.verification?.timeoutMs ?? 0) + 120_000),
      checkpointPolicy: 'none'
    },
    {
      stepId: deliverStep,
      sequence: 4,
      kind: 'deliver',
      objective: `Criar o branch local ${execution.targetBranch} com o tree medido, condicionado à inexistência do ref.`,
      dependsOnStepRefs: [verifyStep],
      inputs: [{ kind: 'step-output', ref: evidenceOutput }],
      actions: [{
        actionId: stableId('action-create-branch', revisionKey),
        scope: 'request-resource',
        resourceRef,
        operation: 'repository.branch.create',
        effectPolicy: {
          mode: 'journaled',
          effectKey: effectKeyForRepositoryChange(taskId, execution),
          uncertaintyHandling: 'reconcile-before-retry',
          recovery: {
            mode: 'retain-and-report',
            description: 'O commit base é o checkpoint endereçado por conteúdo; o branch criado fica para revisão e só o proprietário o mescla ou apaga.'
          }
        }
      }],
      outputs: [{ outputId: receiptOutput, kind: 'effect-receipt', mediaType: 'application/json' }],
      ...common,
      criterionRefs: [],
      timeoutMs: Math.min(60_000, timeoutMs),
      checkpointPolicy: 'before-mutation'
    }
  ]
  const reference = request.context.references.find((item) => item.refId === resourceRef)
  const base: JsonObject = {
    modelVersion: '1.0',
    planId,
    planRevision,
    ...(planRevision > 1 && supersedesPlanRef ? { supersedesPlanRef } : {}),
    taskBinding: { taskId, requestId: request.requestId, requestFingerprint, basisStateRevision },
    contextBindings: [{
      refId: resourceRef,
      digest: reference?.digest && /^sha256:[a-f0-9]{64}$/.test(reference.digest)
        ? reference.digest
        : sha256(`${repositoryUri}@${execution.baseCommit}`),
      capturedAt: now,
      source: 'request-digest'
    }],
    createdAt: now,
    mode: 'sequential',
    strategyFingerprint: fingerprint(steps),
    steps,
    criterionCoverage: request.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      verificationStepRefs: [verifyStep],
      evidenceOutputRefs: [evidenceOutput]
    })),
    outputBinding: {
      kind: request.expectedOutput.kind,
      mediaType: String(request.expectedOutput.mediaType ?? 'text/plain'),
      destinationRef: resourceRef,
      producerStepRef: deliverStep,
      outputRefs: [receiptOutput]
    }
  }
  return { ...base, planFingerprint: fingerprint(base) }
}
