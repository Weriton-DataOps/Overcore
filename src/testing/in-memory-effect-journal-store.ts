import type {
  EffectJournalRecord,
  EffectJournalStore,
  EffectJournalTransition
} from '../ports/effect-journal-store.js'
import { ConcurrentEffectUpdateError } from '../ports/effect-journal-store.js'

function copy<T>(value: T): T {
  return structuredClone(value)
}

/** Os motores com banco devolvem a hora como instante UTC; o in-memory faz o mesmo. */
function instante(value: string): string {
  return new Date(value).toISOString()
}

export class InMemoryEffectJournalStore implements EffectJournalStore {
  readonly records = new Map<string, EffectJournalRecord>()

  async findEffect(effectKey: string): Promise<EffectJournalRecord | null> {
    const found = this.records.get(effectKey)
    return found ? copy(found) : null
  }

  async reserveEffect(record: EffectJournalRecord): Promise<EffectJournalRecord> {
    const existing = this.records.get(record.effectKey)
    if (existing) return copy(existing)
    if ([...this.records.values()].some((item) => item.effectId === record.effectId)) {
      throw new Error(`effectId ${record.effectId} já pertence a outro efeito.`)
    }
    const reserved = { ...copy(record), reservedAt: instante(record.reservedAt), updatedAt: instante(record.updatedAt) }
    if (record.confirmedAt) reserved.confirmedAt = instante(record.confirmedAt)
    this.records.set(record.effectKey, reserved)
    return copy(reserved)
  }

  async transitionEffect(transition: EffectJournalTransition): Promise<EffectJournalRecord> {
    const current = this.records.get(transition.effectKey)
    if (
      !current ||
      current.revision !== transition.expectedRevision ||
      !transition.expectedStates.includes(current.state)
    ) {
      throw new ConcurrentEffectUpdateError(transition.effectKey, transition.expectedRevision)
    }
    const next: EffectJournalRecord = {
      ...current,
      state: transition.nextState,
      revision: current.revision + 1,
      applyCount: current.applyCount + (transition.incrementApplyCount ? 1 : 0),
      updatedAt: instante(transition.updatedAt)
    }
    if (transition.confirmedAt) next.confirmedAt = instante(transition.confirmedAt)
    if (transition.lastObservedDigest) next.lastObservedDigest = transition.lastObservedDigest
    if (transition.lastErrorFingerprint) next.lastErrorFingerprint = transition.lastErrorFingerprint
    this.records.set(next.effectKey, copy(next))
    return copy(next)
  }
}
