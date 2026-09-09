import type {
  EffectJournalRecord,
  EffectJournalStore,
  EffectJournalTransition
} from '../ports/effect-journal-store.js'
import { ConcurrentEffectUpdateError } from '../ports/effect-journal-store.js'

function copy<T>(value: T): T {
  return structuredClone(value)
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
    this.records.set(record.effectKey, copy(record))
    return copy(record)
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
      updatedAt: transition.updatedAt
    }
    if (transition.confirmedAt) next.confirmedAt = transition.confirmedAt
    if (transition.lastObservedDigest) next.lastObservedDigest = transition.lastObservedDigest
    if (transition.lastErrorFingerprint) next.lastErrorFingerprint = transition.lastErrorFingerprint
    this.records.set(next.effectKey, copy(next))
    return copy(next)
  }
}
