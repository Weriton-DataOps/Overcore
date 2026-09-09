import type { PoolClient } from 'pg'

import type { PostgresPool } from './postgres.js'
import type {
  EffectJournalRecord,
  EffectJournalStore,
  EffectJournalTransition
} from '../../ports/effect-journal-store.js'
import { ConcurrentEffectUpdateError } from '../../ports/effect-journal-store.js'

interface EffectJournalRow {
  effect_key: string
  effect_id: string
  task_id: string
  resource_ref: string
  target_uri: string
  operation: 'filesystem.modify'
  intent_fingerprint: `sha256:${string}`
  before_digest: `sha256:${string}`
  after_digest: `sha256:${string}`
  checkpoint_ref: string
  checkpoint_uri: string
  checkpoint_digest: `sha256:${string}`
  state: EffectJournalRecord['state']
  revision: number
  apply_count: number
  reserved_at: Date
  updated_at: Date
  confirmed_at: Date | null
  last_observed_digest: `sha256:${string}` | null
  last_error_fingerprint: `sha256:${string}` | null
}

function map(row: EffectJournalRow): EffectJournalRecord {
  return {
    effectId: row.effect_id,
    effectKey: row.effect_key,
    taskId: row.task_id,
    resourceRef: row.resource_ref,
    targetUri: row.target_uri,
    operation: row.operation,
    intentFingerprint: { algorithm: 'sha256-jcs-v1', value: row.intent_fingerprint },
    beforeDigest: row.before_digest,
    afterDigest: row.after_digest,
    checkpointRef: row.checkpoint_ref,
    checkpointUri: row.checkpoint_uri,
    checkpointDigest: row.checkpoint_digest,
    state: row.state,
    revision: row.revision,
    applyCount: row.apply_count,
    reservedAt: row.reserved_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.confirmed_at ? { confirmedAt: row.confirmed_at.toISOString() } : {}),
    ...(row.last_observed_digest ? { lastObservedDigest: row.last_observed_digest } : {}),
    ...(row.last_error_fingerprint ? { lastErrorFingerprint: row.last_error_fingerprint } : {})
  }
}

async function select(client: Pick<PoolClient, 'query'>, effectKey: string): Promise<EffectJournalRecord | null> {
  const result = await client.query<EffectJournalRow>(
    'SELECT * FROM overcore_effect_journal WHERE effect_key=$1',
    [effectKey]
  )
  const row = result.rows[0]
  return row ? map(row) : null
}

export class PostgresEffectJournalStore implements EffectJournalStore {
  constructor(private readonly pool: PostgresPool) {}

  async findEffect(effectKey: string): Promise<EffectJournalRecord | null> {
    return select(this.pool, effectKey)
  }

  async reserveEffect(record: EffectJournalRecord): Promise<EffectJournalRecord> {
    await this.pool.query(
      `INSERT INTO overcore_effect_journal (
         effect_key, effect_id, task_id, resource_ref, target_uri, operation,
         intent_fingerprint, before_digest, after_digest,
         checkpoint_ref, checkpoint_uri, checkpoint_digest,
         state, revision, apply_count, reserved_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
       ) ON CONFLICT (effect_key) DO NOTHING`,
      [
        record.effectKey,
        record.effectId,
        record.taskId,
        record.resourceRef,
        record.targetUri,
        record.operation,
        record.intentFingerprint.value,
        record.beforeDigest,
        record.afterDigest,
        record.checkpointRef,
        record.checkpointUri,
        record.checkpointDigest,
        record.state,
        record.revision,
        record.applyCount,
        record.reservedAt,
        record.updatedAt
      ]
    )
    const persisted = await this.findEffect(record.effectKey)
    if (!persisted) throw new Error(`A reserva do efeito ${record.effectKey} não foi persistida.`)
    return persisted
  }

  async transitionEffect(transition: EffectJournalTransition): Promise<EffectJournalRecord> {
    const result = await this.pool.query<EffectJournalRow>(
      `UPDATE overcore_effect_journal
       SET state=$1,
           revision=revision+1,
           apply_count=apply_count + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
           updated_at=$3,
           confirmed_at=COALESCE($4::timestamptz, confirmed_at),
           last_observed_digest=COALESCE($5, last_observed_digest),
           last_error_fingerprint=COALESCE($6, last_error_fingerprint)
       WHERE effect_key=$7
         AND revision=$8
         AND state = ANY($9::text[])
       RETURNING *`,
      [
        transition.nextState,
        transition.incrementApplyCount ?? false,
        transition.updatedAt,
        transition.confirmedAt ?? null,
        transition.lastObservedDigest ?? null,
        transition.lastErrorFingerprint ?? null,
        transition.effectKey,
        transition.expectedRevision,
        transition.expectedStates
      ]
    )
    const row = result.rows[0]
    if (!row) throw new ConcurrentEffectUpdateError(transition.effectKey, transition.expectedRevision)
    return map(row)
  }
}
