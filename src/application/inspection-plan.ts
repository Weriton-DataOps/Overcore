import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { fingerprint, sha256, stableId } from '../domain/fingerprint.js'
import type { Fingerprint, JsonObject, TaskRequest } from '../domain/types.js'

function repositoryReference(request: TaskRequest) {
  const reference = request.context.references.find((item) => item.kind === 'repository' || item.kind === 'workspace')
  if (!reference) throw new Error('A inspeção exige uma referência repository ou workspace.')
  if (!reference.uri.startsWith('file:')) throw new Error('A primeira inspeção aceita somente repositório local file://.')
  return reference
}

async function contextDigest(repositoryUri: string): Promise<Fingerprint> {
  const root = fileURLToPath(repositoryUri)
  const contracts = join(root, 'contratos')
  const names = (await readdir(contracts)).filter((name) => name.endsWith('.schema.json')).sort()
  const content: string[] = []
  for (const name of names) content.push(`${name}\n${await readFile(join(contracts, name), 'utf8')}`)
  return { algorithm: 'sha256-jcs-v1', value: sha256(content.join('\n---\n')) }
}

export async function buildInspectionPlan(
  taskId: string,
  request: TaskRequest,
  requestFingerprint: Fingerprint,
  basisStateRevision: number,
  now: string
): Promise<JsonObject> {
  const reference = repositoryReference(request)
  const digest = await contextDigest(reference.uri)
  const planId = stableId('plan-inspection', `${taskId}:1`)
  const steps: JsonObject[] = [
    {
      stepId: stableId('step-enumerate', planId),
      sequence: 1,
      kind: 'prepare',
      objective: 'Enumerar os contratos JSON Schema do repositório sem alterar arquivos.',
      dependsOnStepRefs: [],
      inputs: [{ kind: 'context-reference', ref: reference.refId }],
      actions: [{
        actionId: stableId('action-enumerate', planId),
        scope: 'request-resource',
        resourceRef: reference.refId,
        operation: 'filesystem.read',
        effectPolicy: { mode: 'none' }
      }],
      outputs: [{ outputId: stableId('output-contract-list', planId), kind: 'observation', mediaType: 'application/json' }],
      constraintRefs: request.constraints.map((item) => String(item.id)),
      assumptionRefs: request.context.assumptions.map((item) => String(item.id)),
      criterionRefs: [],
      timeoutMs: Math.min(30_000, request.budget.maxDurationMs),
      checkpointPolicy: 'none'
    },
    {
      stepId: stableId('step-inspect', planId),
      sequence: 2,
      kind: 'verify',
      objective: 'Analisar cada contrato e comprovar leitura e fechamento do objeto raiz.',
      dependsOnStepRefs: [stableId('step-enumerate', planId)],
      inputs: [
        { kind: 'step-output', ref: stableId('output-contract-list', planId) },
        { kind: 'context-reference', ref: reference.refId }
      ],
      actions: [{
        actionId: stableId('action-inspect', planId),
        scope: 'request-resource',
        resourceRef: reference.refId,
        operation: 'filesystem.read',
        effectPolicy: { mode: 'none' }
      }],
      outputs: [
        { outputId: stableId('evidence-json-readable', planId), kind: 'evidence', mediaType: 'application/json' },
        { outputId: stableId('evidence-contract-closed', planId), kind: 'evidence', mediaType: 'application/json' }
      ],
      constraintRefs: request.constraints.map((item) => String(item.id)),
      assumptionRefs: request.context.assumptions.map((item) => String(item.id)),
      criterionRefs: request.acceptanceCriteria.map((criterion) => criterion.id),
      timeoutMs: Math.min(60_000, request.budget.maxDurationMs),
      checkpointPolicy: 'none'
    },
    {
      stepId: stableId('step-deliver', planId),
      sequence: 3,
      kind: 'deliver',
      objective: 'Montar o relatório verificável a partir das evidências da inspeção.',
      dependsOnStepRefs: [stableId('step-inspect', planId)],
      inputs: [
        { kind: 'step-output', ref: stableId('evidence-json-readable', planId) },
        { kind: 'step-output', ref: stableId('evidence-contract-closed', planId) }
      ],
      actions: [{
        actionId: stableId('action-deliver', planId),
        scope: 'runtime-internal',
        operation: 'runtime.assemble-report',
        effectPolicy: { mode: 'none' }
      }],
      outputs: [{ outputId: stableId('output-inspection-report', planId), kind: 'delivery', mediaType: 'application/json' }],
      constraintRefs: request.constraints.map((item) => String(item.id)),
      assumptionRefs: request.context.assumptions.map((item) => String(item.id)),
      criterionRefs: [],
      timeoutMs: Math.min(30_000, request.budget.maxDurationMs),
      checkpointPolicy: 'none'
    }
  ]
  const strategyFingerprint = fingerprint(steps)
  const base: JsonObject = {
    modelVersion: '1.0',
    planId,
    planRevision: 1,
    taskBinding: {
      taskId,
      requestId: request.requestId,
      requestFingerprint,
      basisStateRevision
    },
    contextBindings: [{
      refId: reference.refId,
      digest: digest.value,
      capturedAt: now,
      source: 'admission-snapshot',
      captureEvidenceRef: stableId('evidence-context-capture', `${taskId}:${reference.refId}`)
    }],
    createdAt: now,
    mode: 'sequential',
    strategyFingerprint,
    steps,
    criterionCoverage: request.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      verificationStepRefs: [stableId('step-inspect', planId)],
      evidenceOutputRefs: [
        criterion.verification.method === 'schema'
          ? stableId('evidence-contract-closed', planId)
          : stableId('evidence-json-readable', planId)
      ]
    })),
    outputBinding: {
      kind: request.expectedOutput.kind,
      mediaType: String(request.expectedOutput.mediaType ?? 'application/json'),
      producerStepRef: stableId('step-deliver', planId),
      outputRefs: [stableId('output-inspection-report', planId)]
    }
  }
  return { ...base, planFingerprint: fingerprint(base) }
}

export function repositoryUri(request: TaskRequest): string {
  return repositoryReference(request).uri
}
