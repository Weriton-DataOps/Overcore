import type { DatabaseSync } from 'node:sqlite'

import {
  ConcurrentEffectUpdateError,
  type EffectJournalRecord,
  type EffectJournalStore,
  type EffectJournalTransition
} from '../../../ports/effect-journal-store.js'
import { comBanco, transacao } from './banco.js'
import { instante } from './mapeamento.js'

type Sha = `sha256:${string}`

interface EffectJournalRow {
  effect_key: string
  effect_id: string
  task_id: string
  resource_ref: string
  target_uri: string
  operation: EffectJournalRecord['operation']
  intent_fingerprint: Sha
  before_digest: Sha
  after_digest: Sha
  checkpoint_ref: string
  checkpoint_uri: string
  checkpoint_digest: Sha
  state: EffectJournalRecord['state']
  revision: number
  apply_count: number
  reserved_at: string
  updated_at: string
  confirmed_at: string | null
  last_observed_digest: Sha | null
  last_error_fingerprint: Sha | null
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
    reservedAt: row.reserved_at,
    updatedAt: row.updated_at,
    ...(row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
    ...(row.last_observed_digest ? { lastObservedDigest: row.last_observed_digest } : {}),
    ...(row.last_error_fingerprint ? { lastErrorFingerprint: row.last_error_fingerprint } : {})
  }
}

function select(db: DatabaseSync, effectKey: string): EffectJournalRecord | null {
  const row = db.prepare('SELECT * FROM overcore_effect_journal WHERE effect_key = ?').get(effectKey) as EffectJournalRow | undefined
  return row ? map(row) : null
}

/** Diário de efeitos no SQLite, com o comportamento do PostgresEffectJournalStore (ADR-023). */
export class SqliteEffectJournalStore implements EffectJournalStore {
  constructor(private readonly arquivo: string, private readonly origemMaquina: string) {}

  async findEffect(effectKey: string): Promise<EffectJournalRecord | null> {
    return comBanco(this.arquivo, (db) => select(db, effectKey))
  }

  /** Reserva idempotente pela chave do efeito; a primeira reserva vence, como no PostgreSQL. */
  async reserveEffect(record: EffectJournalRecord): Promise<EffectJournalRecord> {
    const persisted = comBanco(this.arquivo, (db) => transacao(db, () => {
      db.prepare(`INSERT INTO overcore_effect_journal (
          effect_key, effect_id, task_id, resource_ref, target_uri, operation,
          intent_fingerprint, before_digest, after_digest, checkpoint_ref, checkpoint_uri, checkpoint_digest,
          state, revision, apply_count, reserved_at, updated_at, origem_maquina
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (effect_key) DO NOTHING`).run(
        record.effectKey, record.effectId, record.taskId, record.resourceRef, record.targetUri, record.operation,
        record.intentFingerprint.value, record.beforeDigest, record.afterDigest,
        record.checkpointRef, record.checkpointUri, record.checkpointDigest,
        record.state, record.revision, record.applyCount, instante(record.reservedAt), instante(record.updatedAt),
        this.origemMaquina)
      return select(db, record.effectKey)
    }))
    if (!persisted) throw new Error(`A reserva do efeito ${record.effectKey} não foi persistida.`)
    return persisted
  }

  async transitionEffect(transition: EffectJournalTransition): Promise<EffectJournalRecord> {
    const row = comBanco(this.arquivo, (db) => transacao(db, () => db.prepare(`UPDATE overcore_effect_journal
      SET state = $nextState,
          revision = revision + 1,
          apply_count = apply_count + $increment,
          updated_at = $updatedAt,
          confirmed_at = COALESCE($confirmedAt, confirmed_at),
          last_observed_digest = COALESCE($observed, last_observed_digest),
          last_error_fingerprint = COALESCE($error, last_error_fingerprint),
          versao = versao + 1, atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE effect_key = $effectKey
        AND revision = $expectedRevision
        AND state IN (SELECT value FROM json_each($expectedStates))
      RETURNING *`).get({
      nextState: transition.nextState,
      increment: transition.incrementApplyCount ? 1 : 0,
      updatedAt: instante(transition.updatedAt),
      confirmedAt: transition.confirmedAt ? instante(transition.confirmedAt) : null,
      observed: transition.lastObservedDigest ?? null,
      error: transition.lastErrorFingerprint ?? null,
      effectKey: transition.effectKey,
      expectedRevision: transition.expectedRevision,
      expectedStates: JSON.stringify(transition.expectedStates)
    }) as EffectJournalRow | undefined))
    if (!row) throw new ConcurrentEffectUpdateError(transition.effectKey, transition.expectedRevision)
    return map(row)
  }
}
