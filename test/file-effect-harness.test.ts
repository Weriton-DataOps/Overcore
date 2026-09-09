import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  EffectIntentConflictError,
  EffectStateUncertainError,
  FileEffectHarness,
  type FileMutationIntent
} from '../src/application/file-effect-harness.js'
import { fingerprint, sha256, stableId } from '../src/domain/fingerprint.js'
import { FileCheckpointStore } from '../src/infrastructure/checkpoints/file-checkpoint-store.js'
import type {
  EffectAuthorizationCheck,
  EffectAuthorizationEvidence,
  EffectAuthorityGuard
} from '../src/ports/effect-journal-store.js'
import { InMemoryEffectJournalStore } from '../src/testing/in-memory-effect-journal-store.js'

const now = new Date('2026-09-09T12:00:00.000Z')

class RecordingAuthorityGuard implements EffectAuthorityGuard {
  readonly checks: EffectAuthorizationCheck[] = []

  async assertActive(check: EffectAuthorizationCheck): Promise<EffectAuthorizationEvidence> {
    this.checks.push(structuredClone(check))
    if (Date.parse(check.expiresAt) <= now.getTime()) throw new Error('Autorização expirada no guardião.')
    const payload = { ...check, checkedAt: now.toISOString(), outcome: 'active' }
    return {
      checkedAt: now.toISOString(),
      evidenceId: stableId('evidence-authorization-check', `${check.effectId}:${this.checks.length}`),
      digest: fingerprint(payload).value
    }
  }
}

function intent(path: string, desiredContent = 'depois\n'): FileMutationIntent {
  return {
    taskId: 'task-harness-file-0001',
    effectKey: 'task-harness-file-0001/change-file',
    resourceRef: 'ref-harness-disposable-file',
    targetUri: pathToFileURL(path).href,
    desiredContent,
    authorization: {
      enforcementId: 'authenf-harness-file-0001',
      expiresAt: '2026-09-09T13:00:00.000Z',
      operations: ['filesystem.modify'],
      requiredControls: [
        'checkpoint-before-mutation',
        'verify-after-effect',
        'reconcile-before-retry',
        'revocation-check-before-effect'
      ]
    }
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-effect-'))
  const target = join(directory, 'target.txt')
  const checkpoints = join(directory, 'checkpoints')
  await writeFile(target, 'antes\n', 'utf8')
  return { directory, target, checkpoints }
}

test('aplica uma mutação uma vez, cria checkpoint e reconcilia repetição sem reescrever', async () => {
  const files = await fixture()
  try {
    const journal = new InMemoryEffectJournalStore()
    const guard = new RecordingAuthorityGuard()
    const checkpointStore = new FileCheckpointStore(files.checkpoints)
    const harness = new FileEffectHarness(journal, checkpointStore, guard, () => now)

    const first = await harness.apply(intent(files.target))
    assert.equal(first.wrote, true)
    assert.equal(first.journal.state, 'confirmed')
    assert.equal(first.journal.applyCount, 1)
    assert.equal(await readFile(files.target, 'utf8'), 'depois\n')
    assert.equal(Buffer.from(await checkpointStore.read(first.checkpoint)).toString('utf8'), 'antes\n')
    assert.equal(guard.checks.length, 1)
    assert.equal(first.taskResultProjection.effects.length, 1)
    assert.equal(first.taskResultProjection.artifacts[0]?.kind, 'checkpoint')
    assert.equal(first.taskResultProjection.checkpointArtifactRef, first.checkpoint.checkpointRef)

    const repeated = await harness.apply(intent(files.target))
    assert.equal(repeated.wrote, false)
    assert.equal(repeated.journal.applyCount, 1)
    assert.equal(guard.checks.length, 1)

    const expired = intent(files.target)
    expired.authorization.expiresAt = '2026-09-09T11:00:00.000Z'
    const queriedAfterExpiry = await harness.apply(expired)
    assert.equal(queriedAfterExpiry.wrote, false)
    assert.equal(guard.checks.length, 1)
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
})

test('efeito já confirmado que sofreu reversão externa não é reaplicado automaticamente', async () => {
  const files = await fixture()
  try {
    const journal = new InMemoryEffectJournalStore()
    const guard = new RecordingAuthorityGuard()
    const harness = new FileEffectHarness(
      journal,
      new FileCheckpointStore(files.checkpoints),
      guard,
      () => now
    )
    await harness.apply(intent(files.target))
    await writeFile(files.target, 'antes\n', 'utf8')

    await assert.rejects(harness.apply(intent(files.target)), EffectStateUncertainError)
    assert.equal(await readFile(files.target, 'utf8'), 'antes\n')
    assert.equal((await journal.findEffect(intent(files.target).effectKey))?.state, 'unknown')
    assert.equal(guard.checks.length, 1)
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
})

test('conteúdo já igual ao desejado é confirmado como no-op sem escrita ou autorização nova', async () => {
  const files = await fixture()
  try {
    await writeFile(files.target, 'depois\n', 'utf8')
    const journal = new InMemoryEffectJournalStore()
    const guard = new RecordingAuthorityGuard()
    const result = await new FileEffectHarness(
      journal,
      new FileCheckpointStore(files.checkpoints),
      guard,
      () => now
    ).apply(intent(files.target))
    assert.equal(result.wrote, false)
    assert.equal(result.journal.state, 'confirmed')
    assert.equal(result.journal.applyCount, 0)
    assert.equal(guard.checks.length, 0)
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
})

test('queda depois da escrita é reconciliada como confirmada sem duplicar o efeito', async () => {
  const files = await fixture()
  try {
    const journal = new InMemoryEffectJournalStore()
    const guard = new RecordingAuthorityGuard()
    let crashed = false
    const crashing = new FileEffectHarness(
      journal,
      new FileCheckpointStore(files.checkpoints),
      guard,
      () => now,
      { afterAtomicWrite: () => { crashed = true; throw new Error('queda simulada depois da escrita') } }
    )

    await assert.rejects(crashing.apply(intent(files.target)), /queda simulada/)
    assert.equal(crashed, true)
    assert.equal((await journal.findEffect(intent(files.target).effectKey))?.state, 'applying')
    assert.equal(await readFile(files.target, 'utf8'), 'depois\n')

    const recovered = await new FileEffectHarness(
      journal,
      new FileCheckpointStore(files.checkpoints),
      guard,
      () => now
    ).apply(intent(files.target))
    assert.equal(recovered.wrote, false)
    assert.equal(recovered.journal.state, 'confirmed')
    assert.equal(recovered.journal.applyCount, 1)
    assert.equal(guard.checks.length, 1)
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
})

test('queda antes da escrita é marcada not-applied, reautorizada e retomada', async () => {
  const files = await fixture()
  try {
    const journal = new InMemoryEffectJournalStore()
    const guard = new RecordingAuthorityGuard()
    const crashing = new FileEffectHarness(
      journal,
      new FileCheckpointStore(files.checkpoints),
      guard,
      () => now,
      { afterMarkedApplying: () => { throw new Error('queda simulada antes da escrita') } }
    )

    await assert.rejects(crashing.apply(intent(files.target)), /queda simulada/)
    assert.equal(await readFile(files.target, 'utf8'), 'antes\n')

    const recovered = await new FileEffectHarness(
      journal,
      new FileCheckpointStore(files.checkpoints),
      guard,
      () => now
    ).apply(intent(files.target))
    assert.equal(recovered.wrote, true)
    assert.equal(recovered.journal.state, 'confirmed')
    assert.equal(recovered.journal.applyCount, 2)
    assert.equal(guard.checks.length, 2)
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
})

test('estado divergente vira unknown e nunca é sobrescrito por retry cego', async () => {
  const files = await fixture()
  try {
    const journal = new InMemoryEffectJournalStore()
    const guard = new RecordingAuthorityGuard()
    const crashing = new FileEffectHarness(
      journal,
      new FileCheckpointStore(files.checkpoints),
      guard,
      () => now,
      { afterMarkedApplying: () => { throw new Error('queda simulada') } }
    )
    await assert.rejects(crashing.apply(intent(files.target)), /queda simulada/)
    await writeFile(files.target, 'alteração concorrente\n', 'utf8')

    await assert.rejects(
      new FileEffectHarness(
        journal,
        new FileCheckpointStore(files.checkpoints),
        guard,
        () => now
      ).apply(intent(files.target)),
      EffectStateUncertainError
    )
    assert.equal(await readFile(files.target, 'utf8'), 'alteração concorrente\n')
    assert.equal((await journal.findEffect(intent(files.target).effectKey))?.state, 'unknown')
    assert.equal(guard.checks.length, 1)
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
})

test('a mesma effectKey não pode esconder outra intenção', async () => {
  const files = await fixture()
  try {
    const journal = new InMemoryEffectJournalStore()
    const guard = new RecordingAuthorityGuard()
    const harness = new FileEffectHarness(
      journal,
      new FileCheckpointStore(files.checkpoints),
      guard,
      () => now
    )
    await harness.apply(intent(files.target))
    await assert.rejects(harness.apply(intent(files.target, 'outro destino\n')), EffectIntentConflictError)
    assert.equal(await readFile(files.target, 'utf8'), 'depois\n')
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
})

test('sem os quatro controles a escrita é rejeitada antes de criar journal ou checkpoint', async () => {
  const files = await fixture()
  try {
    const journal = new InMemoryEffectJournalStore()
    const badIntent = intent(files.target)
    badIntent.authorization.requiredControls = ['verify-after-effect']
    await assert.rejects(
      new FileEffectHarness(
        journal,
        new FileCheckpointStore(files.checkpoints),
        new RecordingAuthorityGuard(),
        () => now
      ).apply(badIntent),
      /checkpoint-before-mutation/
    )
    assert.equal(journal.records.size, 0)
    assert.equal(await readFile(files.target, 'utf8'), 'antes\n')
    assert.equal(sha256(await readFile(files.target)), sha256(Buffer.from('antes\n')))
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
})
