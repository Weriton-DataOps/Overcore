import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { FileEffectHarness } from '../src/application/file-effect-harness.js'
import { fingerprint, stableId } from '../src/domain/fingerprint.js'
import { FileCheckpointStore } from '../src/infrastructure/checkpoints/file-checkpoint-store.js'
import { PostgresEffectJournalStore } from '../src/infrastructure/database/postgres-effect-journal-store.js'
import { createPostgresPool, migrate } from '../src/infrastructure/database/postgres.js'
import type { EffectAuthorityGuard } from '../src/ports/effect-journal-store.js'

const root = process.cwd()

test('PostgreSQL preserva o journal e permite reconciliar o efeito após reinício', async () => {
  const connectionString = process.env.OVERCORE_TEST_DATABASE_URL
  if (!connectionString) throw new Error('Gate não executado: defina OVERCORE_TEST_DATABASE_URL.')
  const pool = createPostgresPool(connectionString)
  const directory = await mkdtemp(join(tmpdir(), 'overcore-effect-postgres-'))
  const effectKey = `task-postgres-effect-${randomUUID()}/file-change`
  try {
    await migrate(pool, root)
    const target = join(directory, 'target.txt')
    await writeFile(target, 'antes\n', 'utf8')
    const now = new Date()
    const guard: EffectAuthorityGuard = {
      assertActive: async (check) => ({
        checkedAt: now.toISOString(),
        evidenceId: stableId('evidence-auth-check', check.effectId),
        digest: fingerprint({ ...check, outcome: 'active' }).value
      })
    }
    const request = {
      taskId: `task-postgres-effect-${randomUUID()}`,
      effectKey,
      resourceRef: 'ref-postgres-effect-file',
      targetUri: pathToFileURL(target).href,
      desiredContent: 'depois\n',
      authorization: {
        enforcementId: 'authenf-postgres-effect-0001',
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        operations: ['filesystem.modify'],
        requiredControls: [
          'checkpoint-before-mutation',
          'verify-after-effect',
          'reconcile-before-retry',
          'revocation-check-before-effect'
        ]
      }
    }
    const first = await new FileEffectHarness(
      new PostgresEffectJournalStore(pool),
      new FileCheckpointStore(join(directory, 'checkpoints')),
      guard
    ).apply(request)
    assert.equal(first.wrote, true)

    const recovered = await new FileEffectHarness(
      new PostgresEffectJournalStore(pool),
      new FileCheckpointStore(join(directory, 'checkpoints')),
      guard
    ).apply(request)
    assert.equal(recovered.wrote, false)
    assert.equal(recovered.journal.applyCount, 1)
    assert.equal(await readFile(target, 'utf8'), 'depois\n')
  } finally {
    await pool.query('DELETE FROM overcore_effect_journal WHERE effect_key=$1', [effectKey])
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  }
})
