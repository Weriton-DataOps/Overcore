import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fingerprint, sha256, stableId } from '../domain/fingerprint.js'
import type { Fingerprint, JsonObject } from '../domain/types.js'
import type {
  CheckpointArtifact,
  CheckpointStore,
  EffectAuthorityGuard,
  EffectAuthorizationEvidence,
  EffectJournalRecord,
  EffectJournalState,
  EffectJournalStore
} from '../ports/effect-journal-store.js'

const REQUIRED_CONTROLS = [
  'checkpoint-before-mutation',
  'verify-after-effect',
  'reconcile-before-retry',
  'revocation-check-before-effect'
] as const

export interface FileMutationAuthorization {
  enforcementId: string
  expiresAt: string
  operations: string[]
  requiredControls: string[]
}

export interface FileMutationIntent {
  taskId: string
  effectKey: string
  resourceRef: string
  targetUri: string
  desiredContent: string
  expectedBeforeDigest?: `sha256:${string}`
  authorization: FileMutationAuthorization
}

export interface FileMutationEvidence {
  evidenceId: string
  kind: 'state-readback'
  capturedAt: string
  summary: string
  digest: `sha256:${string}`
  artifactRefs: string[]
  origin: { kind: 'executor'; id: string }
}

export interface FileMutationResult {
  journal: EffectJournalRecord
  checkpoint: CheckpointArtifact
  authorizationEvidence?: EffectAuthorizationEvidence
  evidence: FileMutationEvidence
  effect: JsonObject
  taskResultProjection: {
    evidence: JsonObject[]
    artifacts: JsonObject[]
    effects: JsonObject[]
    checkpointArtifactRef: string
  }
  wrote: boolean
}

export interface FileEffectHarnessHooks {
  afterMarkedApplying?(record: EffectJournalRecord): Promise<void> | void
  afterAtomicWrite?(record: EffectJournalRecord): Promise<void> | void
}

export class EffectIntentConflictError extends Error {
  constructor(effectKey: string) {
    super(`A effectKey ${effectKey} já pertence a outra intenção lógica.`)
    this.name = 'EffectIntentConflictError'
  }
}

export class EffectStateUncertainError extends Error {
  constructor(effectKey: string) {
    super(`O efeito ${effectKey} está em estado incerto; a escrita não foi repetida.`)
    this.name = 'EffectStateUncertainError'
  }
}

function intentFingerprint(intent: FileMutationIntent, afterDigest: `sha256:${string}`): Fingerprint {
  return fingerprint({
    taskId: intent.taskId,
    effectKey: intent.effectKey,
    resourceRef: intent.resourceRef,
    targetUri: intent.targetUri,
    operation: 'filesystem.modify',
    afterDigest,
    ...(intent.expectedBeforeDigest ? { expectedBeforeDigest: intent.expectedBeforeDigest } : {})
  })
}

async function atomicWrite(path: string, content: Uint8Array): Promise<void> {
  const metadata = await stat(path)
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.overcore-tmp`)
  try {
    const handle = await open(temporary, 'wx', metadata.mode)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function checkpointFrom(record: EffectJournalRecord): CheckpointArtifact {
  return {
    checkpointRef: record.checkpointRef,
    uri: record.checkpointUri,
    digest: record.checkpointDigest
  }
}

function assertSameIntent(record: EffectJournalRecord, expected: Fingerprint): void {
  if (record.intentFingerprint.value !== expected.value) throw new EffectIntentConflictError(record.effectKey)
}

export class FileEffectHarness {
  constructor(
    private readonly journal: EffectJournalStore,
    private readonly checkpoints: CheckpointStore,
    private readonly authority: EffectAuthorityGuard,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: FileEffectHarnessHooks = {}
  ) {}

  async apply(intent: FileMutationIntent): Promise<FileMutationResult> {
    this.assertIntent(intent)
    const path = fileURLToPath(intent.targetUri)
    const desired = Buffer.from(intent.desiredContent, 'utf8')
    const afterDigest = sha256(desired)
    const logicalFingerprint = intentFingerprint(intent, afterDigest)
    let record = await this.journal.findEffect(intent.effectKey)

    if (!record) {
      const before = await readFile(path)
      const beforeDigest = sha256(before)
      if (intent.expectedBeforeDigest && intent.expectedBeforeDigest !== beforeDigest) {
        throw new Error('O arquivo não corresponde à precondição declarada pela tarefa.')
      }
      const effectId = stableId('effect', intent.effectKey)
      const checkpointRef = stableId('checkpoint', `${intent.taskId}:${intent.effectKey}`)
      const checkpoint = await this.checkpoints.save(checkpointRef, before)
      const reservedAt = this.now().toISOString()
      record = await this.journal.reserveEffect({
        effectId,
        effectKey: intent.effectKey,
        taskId: intent.taskId,
        resourceRef: intent.resourceRef,
        targetUri: intent.targetUri,
        operation: 'filesystem.modify',
        intentFingerprint: logicalFingerprint,
        beforeDigest,
        afterDigest,
        checkpointRef: checkpoint.checkpointRef,
        checkpointUri: checkpoint.uri,
        checkpointDigest: checkpoint.digest,
        state: 'reserved',
        revision: 1,
        applyCount: 0,
        reservedAt,
        updatedAt: reservedAt
      })
    }
    assertSameIntent(record, logicalFingerprint)

    record = await this.reconcile(record, path)
    if (record.state === 'confirmed') return this.result(record, false)
    if (record.state === 'unknown') throw new EffectStateUncertainError(record.effectKey)
    if (record.state === 'rolled-back') throw new Error(`O efeito ${record.effectKey} já foi revertido.`)

    // Expiração é verificada no último instante possível: depois da reconciliação
    // provar que uma escrita ainda é necessária e antes de tocar o arquivo.
    this.assertAuthorizationFresh(intent.authorization)
    const authorizationEvidence = await this.authority.assertActive({
      taskId: record.taskId,
      effectKey: record.effectKey,
      effectId: record.effectId,
      resourceRef: record.resourceRef,
      targetUri: record.targetUri,
      operation: record.operation,
      intentFingerprint: record.intentFingerprint,
      enforcementId: intent.authorization.enforcementId,
      expiresAt: intent.authorization.expiresAt,
      requiredControls: intent.authorization.requiredControls
    })

    const observedBeforeWrite = sha256(await readFile(path))
    if (observedBeforeWrite !== record.beforeDigest) {
      record = await this.markFromObserved(record, observedBeforeWrite)
      if (record.state === 'confirmed') return this.result(record, false, authorizationEvidence)
      throw new EffectStateUncertainError(record.effectKey)
    }

    record = await this.journal.transitionEffect({
      effectKey: record.effectKey,
      expectedRevision: record.revision,
      expectedStates: ['reserved', 'not-applied'],
      nextState: 'applying',
      updatedAt: this.now().toISOString(),
      incrementApplyCount: true,
      lastObservedDigest: observedBeforeWrite
    })
    await this.hooks.afterMarkedApplying?.(record)

    try {
      await atomicWrite(path, desired)
      await this.hooks.afterAtomicWrite?.(record)
    } catch (error) {
      const observed = sha256(await readFile(path))
      if (observed === record.afterDigest) throw error
      await this.journal.transitionEffect({
        effectKey: record.effectKey,
        expectedRevision: record.revision,
        expectedStates: ['applying'],
        nextState: observed === record.beforeDigest ? 'not-applied' : 'unknown',
        updatedAt: this.now().toISOString(),
        lastObservedDigest: observed,
        lastErrorFingerprint: sha256(error instanceof Error ? `${error.name}:${error.message}` : String(error))
      })
      throw error
    }

    const observedAfterWrite = sha256(await readFile(path))
    if (observedAfterWrite !== record.afterDigest) {
      await this.journal.transitionEffect({
        effectKey: record.effectKey,
        expectedRevision: record.revision,
        expectedStates: ['applying'],
        nextState: 'unknown',
        updatedAt: this.now().toISOString(),
        lastObservedDigest: observedAfterWrite
      })
      throw new EffectStateUncertainError(record.effectKey)
    }
    const confirmedAt = this.now().toISOString()
    record = await this.journal.transitionEffect({
      effectKey: record.effectKey,
      expectedRevision: record.revision,
      expectedStates: ['applying'],
      nextState: 'confirmed',
      updatedAt: confirmedAt,
      confirmedAt,
      lastObservedDigest: observedAfterWrite
    })
    return this.result(record, true, authorizationEvidence)
  }

  private assertIntent(intent: FileMutationIntent): void {
    if (!intent.targetUri.startsWith('file:')) throw new Error('Harness de arquivo aceita somente file://.')
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/.test(intent.effectKey)) {
      throw new Error('effectKey inválida.')
    }
    if (!intent.authorization.operations.includes('filesystem.modify')) {
      throw new Error('A autorização não concede filesystem.modify.')
    }
    for (const control of REQUIRED_CONTROLS) {
      if (!intent.authorization.requiredControls.includes(control)) {
        throw new Error(`A autorização não exige o controle ${control}.`)
      }
    }
  }

  private assertAuthorizationFresh(authorization: FileMutationAuthorization): void {
    if (Date.parse(authorization.expiresAt) <= this.now().getTime()) {
      throw new Error('A autorização do efeito expirou.')
    }
  }

  private async reconcile(record: EffectJournalRecord, path: string): Promise<EffectJournalRecord> {
    const observed = sha256(await readFile(path))
    if (record.state === 'confirmed') {
      if (observed === record.afterDigest) return record
      return this.journal.transitionEffect({
        effectKey: record.effectKey,
        expectedRevision: record.revision,
        expectedStates: ['confirmed'],
        nextState: 'unknown',
        updatedAt: this.now().toISOString(),
        lastObservedDigest: observed
      })
    }
    if (record.state === 'applying' || record.state === 'unknown') {
      return this.markFromObserved(record, observed)
    }
    if (record.state === 'reserved' || record.state === 'not-applied') {
      if (observed === record.afterDigest) return this.markFromObserved(record, observed)
      if (observed !== record.beforeDigest) return this.markFromObserved(record, observed)
    }
    return record
  }

  private async markFromObserved(
    record: EffectJournalRecord,
    observed: `sha256:${string}`
  ): Promise<EffectJournalRecord> {
    const nextState: EffectJournalState = observed === record.afterDigest
      ? 'confirmed'
      : observed === record.beforeDigest
        ? 'not-applied'
        : 'unknown'
    const at = this.now().toISOString()
    return this.journal.transitionEffect({
      effectKey: record.effectKey,
      expectedRevision: record.revision,
      expectedStates: [record.state],
      nextState,
      updatedAt: at,
      ...(nextState === 'confirmed' ? { confirmedAt: at } : {}),
      lastObservedDigest: observed
    })
  }

  private result(
    record: EffectJournalRecord,
    wrote: boolean,
    authorizationEvidence?: EffectAuthorizationEvidence
  ): FileMutationResult {
    const capturedAt = record.confirmedAt ?? record.updatedAt
    const evidenceId = stableId('evidence-effect-readback', `${record.effectId}:${record.revision}`)
    const evidence: FileMutationEvidence = {
      evidenceId,
      kind: 'state-readback',
      capturedAt,
      summary: wrote
        ? 'A mutação foi aplicada atomicamente e confirmada por leitura posterior.'
        : 'O efeito já estava materializado e foi confirmado por reconciliação, sem nova escrita.',
      digest: record.afterDigest,
      artifactRefs: [record.checkpointRef],
      origin: { kind: 'executor', id: 'overcore-file-effect-harness-v1' }
    }
    const checkpointArtifact: JsonObject = {
      artifactId: record.checkpointRef,
      kind: 'checkpoint',
      uri: record.checkpointUri,
      digest: record.checkpointDigest,
      mediaType: 'application/octet-stream',
      sensitivity: 'internal',
      createdAt: record.reservedAt
    }
    const authorizationEvidenceDocument: JsonObject | undefined = authorizationEvidence ? {
      evidenceId: authorizationEvidence.evidenceId,
      kind: 'external-receipt',
      capturedAt: authorizationEvidence.checkedAt,
      summary: 'A autoridade foi revalidada imediatamente antes da mutação.',
      digest: authorizationEvidence.digest,
      artifactRefs: [],
      origin: { kind: 'external', id: 'omni-authority-provider' }
    } : undefined
    const effect: JsonObject = {
      effectId: record.effectId,
      effectKey: record.effectKey,
      intentFingerprint: record.intentFingerprint,
      resourceRef: record.resourceRef,
      operation: record.operation,
      status: 'confirmed',
      evidenceRefs: [
        evidenceId,
        ...(authorizationEvidenceDocument ? [String(authorizationEvidenceDocument.evidenceId)] : [])
      ]
    }
    const evidenceDocuments: JsonObject[] = [evidence as unknown as JsonObject]
    if (authorizationEvidenceDocument) evidenceDocuments.push(authorizationEvidenceDocument)
    return {
      journal: record,
      checkpoint: checkpointFrom(record),
      ...(authorizationEvidence ? { authorizationEvidence } : {}),
      evidence,
      effect,
      taskResultProjection: {
        evidence: evidenceDocuments,
        artifacts: [checkpointArtifact],
        effects: [effect],
        checkpointArtifactRef: record.checkpointRef
      },
      wrote
    }
  }
}
