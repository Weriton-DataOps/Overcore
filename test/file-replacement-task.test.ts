import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { HarnessFileReplacementExecutor } from '../src/application/file-replacement-executor.js'
import { buildAuthorizationRequest, permittingDecision } from '../src/application/authorization.js'
import { BaselineDiscovery } from '../src/application/baseline-discovery.js'
import { FileEffectHarness } from '../src/application/file-effect-harness.js'
import { buildFileReplacementPlan } from '../src/application/file-replacement-plan.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskPreflight } from '../src/application/task-preflight.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { fingerprint, sha256 } from '../src/domain/fingerprint.js'
import type { JsonObject, TaskDraft, TaskRequest } from '../src/domain/types.js'
import { FileCheckpointStore } from '../src/infrastructure/checkpoints/file-checkpoint-store.js'
import type { EffectAuthorizationCheck, EffectAuthorityGuard } from '../src/ports/effect-journal-store.js'
import { InMemoryEffectJournalStore } from '../src/testing/in-memory-effect-journal-store.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()

class ActiveGuard implements EffectAuthorityGuard {
  readonly checks: EffectAuthorizationCheck[] = []

  async assertActive(check: EffectAuthorizationCheck) {
    this.checks.push(structuredClone(check))
    return {
      checkedAt: '2026-09-09T12:00:00.000Z',
      evidenceId: 'revalidation-file-task-0001',
      digest: sha256(JSON.stringify({ effectKey: check.effectKey, actionId: check.actionId }))
    }
  }
}

function request(targetUri: string, before: string, after: string, suffix: string): TaskRequest {
  return {
    contractVersion: '1.0',
    requestId: `request-file-replacement-${suffix}`,
    idempotencyKey: `file-replacement-execution-${suffix}`,
    createdAt: '2026-09-09T12:00:00.000Z',
    preflight: {
      draftId: `draft-file-replacement-${suffix}`,
      draftRevision: 1,
      draftFingerprint: { algorithm: 'sha256-jcs-v1', value: sha256(`draft-${suffix}`) },
      readinessReportId: `readiness-file-replacement-${suffix}`
    },
    client: { id: 'client-overcore-test', kind: 'automation' },
    objective: 'Substituir o conteúdo previamente declarado de um único arquivo temporário.',
    priority: 'normal',
    context: {
      references: [{
        refId: `ref-target-file-${suffix}`,
        uri: targetUri,
        kind: 'file',
        sensitivity: 'internal'
      }],
      assumptions: []
    },
    constraints: [{
      id: `constraint-single-file-${suffix}`,
      kind: 'quality',
      description: 'Somente o arquivo declarado pode receber conteúdo novo.'
    }],
    authority: {
      mode: 'proceed-within-scope',
      grants: [{
        resourceRef: `ref-target-file-${suffix}`,
        operations: ['filesystem.read', 'filesystem.modify']
      }],
      expansionBoundaries: [
        'destructive', 'irreversible', 'financial', 'privilege-expansion', 'external-publication', 'secret-access'
      ]
    },
    acceptanceCriteria: [{
      id: `criterion-file-readback-${suffix}`,
      description: 'O arquivo contém exatamente o conteúdo congelado no pedido.',
      verification: { method: 'inspection', expected: 'Readback confirma o digest do conteúdo novo.' }
    }],
    budget: { maxDurationMs: 300_000, maxAttempts: 2, maxParallelism: 1 },
    expectedOutput: { kind: 'file', mediaType: 'text/plain', destinationRef: `ref-target-file-${suffix}` },
    execution: {
      kind: 'replace-file-content',
      resourceRef: `ref-target-file-${suffix}`,
      desiredContent: after,
      expectedBeforeDigest: sha256(before)
    }
  }
}

function draft(targetUri: string, before: string, after: string): TaskDraft {
  return {
    contractVersion: '1.0',
    draftId: 'draft-file-replacement-preflight-0001',
    revision: 1,
    idempotencyKey: 'prepare-file-replacement-0001',
    executionIdempotencyKey: 'execute-file-replacement-0001',
    createdAt: '2026-09-09T12:00:00.000Z',
    client: { id: 'client-overcore-test', kind: 'automation' },
    objective: 'Trocar o conteúdo de um arquivo explicitamente definido.',
    context: {
      references: [{ refId: 'ref-file-preflight-0001', uri: targetUri, kind: 'file', sensitivity: 'internal' }],
      assumptions: []
    },
    knownConstraints: [{
      id: 'constraint-file-preflight-0001', kind: 'quality', description: 'Somente o arquivo declarado pode mudar.'
    }],
    knownAcceptanceCriteria: [{
      id: 'criterion-file-preflight-0001', description: 'O readback confirma o conteúdo novo.', verificationHint: 'inspection'
    }],
    discoveryAuthority: {
      mode: 'inspect-only',
      grants: [{ resourceRef: 'ref-file-preflight-0001', operations: [{ name: 'filesystem.read', effect: 'read' }] }]
    },
    availableExecutionAuthority: {
      mode: 'proceed-within-scope',
      grants: [{ resourceRef: 'ref-file-preflight-0001', operations: ['filesystem.read', 'filesystem.modify'] }],
      expansionBoundaries: [
        'destructive', 'irreversible', 'financial', 'privilege-expansion', 'external-publication', 'secret-access'
      ]
    },
    executionBudget: {
      source: {
        kind: 'policy-default',
        sourceId: 'policy-file-preflight-0001',
        sourceVersion: '1.0',
        sourceDigest: sha256('policy-file-preflight-0001')
      },
      limits: { maxDurationMs: 300_000, maxAttempts: 2, maxParallelism: 1 }
    },
    decisionAnswers: [],
    preflightBudget: { maxDurationMs: 60_000, maxInspectionOperations: 1 },
    executionHints: {
      priority: 'normal',
      expectedOutputKind: 'file',
      fileReplacement: {
        kind: 'replace-file-content',
        resourceRef: 'ref-file-preflight-0001',
        desiredContent: after,
        expectedBeforeDigest: sha256(before)
      }
    }
  }
}

test('Preflight congela a substituição de arquivo no TaskRequest antes da admissão', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-file-preflight-'))
  try {
    const target = join(directory, 'target.txt')
    const before = 'antes\n'
    const after = 'depois\n'
    await writeFile(target, before, 'utf8')
    const validator = await ContractValidator.create(root)
    const report = await new TaskPreflight(validator, new BaselineDiscovery(), new InMemoryTaskStore()).run(
      draft(pathToFileURL(target).href, before, after)
    )
    assert.equal(report.status, 'ready')
    assert.deepEqual(report.preparedRequest?.execution, {
      kind: 'replace-file-content',
      resourceRef: 'ref-file-preflight-0001',
      desiredContent: after,
      expectedBeforeDigest: sha256(before)
    })
    assert.equal(report.preparedRequest?.expectedOutput.destinationRef, 'ref-file-preflight-0001')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('TaskManager executa substituição de arquivo com autorização, checkpoint, readback e idempotência', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-file-task-'))
  try {
    const target = join(directory, 'target.txt')
    const before = 'conteúdo anterior\n'
    const after = 'conteúdo novo e congelado\n'
    await writeFile(target, before, 'utf8')
    const validator = await ContractValidator.create(root)
    const store = new InMemoryTaskStore()
    const journal = new InMemoryEffectJournalStore()
    const guard = new ActiveGuard()
    const worker = new TaskWorker(
      'worker-file-task',
      store,
      validator,
      new ReadOnlyContractInspectionExecutor(),
      undefined,
      new HarnessFileReplacementExecutor(new FileEffectHarness(
        journal,
        new FileCheckpointStore(join(directory, 'checkpoints')),
        guard
      ))
    )
    const taskRequest = request(pathToFileURL(target).href, before, after, '0001')
    const plan = buildFileReplacementPlan('task-file-replacement-0001', taskRequest, fingerprint(taskRequest), 2, taskRequest.createdAt)
    validator.assert('execution-plan', plan)
    const authorization = buildAuthorizationRequest(taskRequest, fingerprint(taskRequest), plan, taskRequest.createdAt)
    validator.assert('authorization-request', authorization)
    validator.assert('authorization-decision', permittingDecision(authorization))
    const scheduled = await new TaskManager(store, validator, new PermittingAuthorityProvider()).submit(taskRequest)

    assert.equal(scheduled.status, 'running', JSON.stringify(scheduled.reconciliation))
    const message = [...store.outbox.values()][0]
    assert.equal(message?.kind, 'execute-file-replacement')
    assert.equal(message?.payload.targetUri, pathToFileURL(target).href)

    const completed = await worker.runOnce()
    assert.equal(completed?.status, 'succeeded')
    assert.equal(await readFile(target, 'utf8'), after)
    assert.equal(journal.records.size, 1)
    assert.equal([...journal.records.values()][0]?.state, 'confirmed')
    assert.equal([...journal.records.values()][0]?.applyCount, 1)
    assert.equal(guard.checks.length, 1)
    assert.equal(guard.checks[0]?.operation, 'filesystem.modify')
    assert.ok(guard.checks[0]?.authorizationRequest)
    assert.ok(guard.checks[0]?.actionId)
    const result = completed?.result as JsonObject
    assert.equal((result.effects as JsonObject[])[0]?.status, 'confirmed')
    assert.ok(((result.execution as JsonObject).checkpointArtifactRef as string).startsWith('checkpoint-'))
    assert.equal(await worker.runOnce(), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('precondição divergente não reescreve o arquivo nem pula a verificação', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-file-precondition-'))
  try {
    const target = join(directory, 'target.txt')
    await writeFile(target, 'conteúdo real\n', 'utf8')
    const validator = await ContractValidator.create(root)
    const store = new InMemoryTaskStore()
    const journal = new InMemoryEffectJournalStore()
    const worker = new TaskWorker(
      'worker-file-precondition', store, validator, new ReadOnlyContractInspectionExecutor(), undefined,
      new HarnessFileReplacementExecutor(new FileEffectHarness(
        journal, new FileCheckpointStore(join(directory, 'checkpoints')), new ActiveGuard()
      ))
    )
    await new TaskManager(store, validator, new PermittingAuthorityProvider())
      .submit(request(pathToFileURL(target).href, 'conteúdo esperado diferente\n', 'novo\n', '0002'))
    const completed = await worker.runOnce()
    assert.equal(completed?.status, 'failed')
    assert.equal(await readFile(target, 'utf8'), 'conteúdo real\n')
    assert.equal(journal.records.size, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
