import type {
  Fingerprint,
  TaskDraft,
  TaskReadinessReport
} from '../domain/types.js'

export interface StoredPreflightRevision {
  draftId: string
  revision: number
  idempotencyKey: string
  draftFingerprint: Fingerprint
  draft: TaskDraft
  reportId: string
  reportFingerprint: Fingerprint
  report: TaskReadinessReport
  createdAt: string
}

export class ConcurrentPreflightUpdateError extends Error {
  constructor(readonly draftId: string, readonly expectedPreviousRevision: number) {
    super(`O Preflight ${draftId} não está mais na revisão anterior ${expectedPreviousRevision}.`)
    this.name = 'ConcurrentPreflightUpdateError'
  }
}

export class DuplicatePreflightIntentError extends Error {
  constructor(readonly existingDraftId: string) {
    super(`A chave idempotente da preparação já pertence ao draft ${existingDraftId}.`)
    this.name = 'DuplicatePreflightIntentError'
  }
}

export interface PreflightStore {
  findPreflightRevision(draftId: string, revision: number): Promise<StoredPreflightRevision | null>
  findPreflightReport(reportId: string): Promise<TaskReadinessReport | null>
  findLatestPreflightByIdempotencyKey(idempotencyKey: string): Promise<StoredPreflightRevision | null>
  appendPreflightRevision(
    record: StoredPreflightRevision,
    expectedPreviousRevision: number
  ): Promise<StoredPreflightRevision>
}
