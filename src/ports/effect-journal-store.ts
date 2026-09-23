import type { Fingerprint, JsonObject } from '../domain/types.js'

export type EffectJournalState =
  | 'reserved'
  | 'applying'
  | 'confirmed'
  | 'not-applied'
  | 'unknown'
  | 'rolled-back'

export interface EffectJournalRecord {
  effectId: string
  effectKey: string
  taskId: string
  resourceRef: string
  targetUri: string
  operation: 'filesystem.modify' | 'database.schema.modify'
  intentFingerprint: Fingerprint
  beforeDigest: `sha256:${string}`
  afterDigest: `sha256:${string}`
  checkpointRef: string
  checkpointUri: string
  checkpointDigest: `sha256:${string}`
  state: EffectJournalState
  revision: number
  applyCount: number
  reservedAt: string
  updatedAt: string
  confirmedAt?: string
  lastObservedDigest?: `sha256:${string}`
  lastErrorFingerprint?: `sha256:${string}`
}

export interface EffectJournalTransition {
  effectKey: string
  expectedRevision: number
  expectedStates: EffectJournalState[]
  nextState: EffectJournalState
  updatedAt: string
  incrementApplyCount?: boolean
  confirmedAt?: string
  lastObservedDigest?: `sha256:${string}`
  lastErrorFingerprint?: `sha256:${string}`
}

export class ConcurrentEffectUpdateError extends Error {
  constructor(readonly effectKey: string, readonly expectedRevision: number) {
    super(`O efeito ${effectKey} não está mais na revisão ${expectedRevision}.`)
    this.name = 'ConcurrentEffectUpdateError'
  }
}

export interface EffectJournalStore {
  findEffect(effectKey: string): Promise<EffectJournalRecord | null>
  reserveEffect(record: EffectJournalRecord): Promise<EffectJournalRecord>
  transitionEffect(transition: EffectJournalTransition): Promise<EffectJournalRecord>
}

export interface CheckpointArtifact {
  checkpointRef: string
  uri: string
  digest: `sha256:${string}`
}

export interface CheckpointStore {
  save(checkpointRef: string, content: Uint8Array): Promise<CheckpointArtifact>
  read(artifact: CheckpointArtifact): Promise<Uint8Array>
}

export interface EffectAuthorizationCheck {
  taskId: string
  effectKey: string
  effectId: string
  resourceRef: string
  targetUri: string
  operation: 'filesystem.modify' | 'database.schema.modify'
  intentFingerprint: Fingerprint
  enforcementId: string
  expiresAt: string
  requiredControls: string[]
  /** Pedido original, preservado pelo Task Manager; o guardiao HTTP o vincula ao efeito. */
  authorizationRequest?: JsonObject
  /** Acao journaled exata dentro do pedido original. */
  actionId?: string
}

export interface EffectAuthorizationEvidence {
  checkedAt: string
  evidenceId: string
  digest: `sha256:${string}`
}

export interface EffectAuthorityGuard {
  assertActive(check: EffectAuthorizationCheck): Promise<EffectAuthorizationEvidence>
}
