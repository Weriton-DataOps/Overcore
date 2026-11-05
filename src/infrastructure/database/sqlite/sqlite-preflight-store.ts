import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

import type { TaskDraft, TaskReadinessReport } from '../../../domain/types.js'
import {
  ConcurrentPreflightUpdateError,
  DuplicatePreflightIntentError,
  type PreflightStore,
  type StoredPreflightRevision
} from '../../../ports/preflight-store.js'
import { comBanco, transacao } from './banco.js'
import { instante, lerJson, unicidade } from './mapeamento.js'

type Linha = Record<string, SQLInputValue>

interface PreflightRevisionRow {
  draft_id: string
  revision: number
  idempotency_key: string
  draft_fingerprint: string
  draft_document: string
  report_id: string
  report_fingerprint: string
  report_document: string
  created_at: string
}

function mapPreflight(row: PreflightRevisionRow): StoredPreflightRevision {
  return {
    draftId: row.draft_id,
    revision: row.revision,
    idempotencyKey: row.idempotency_key,
    draftFingerprint: { algorithm: 'sha256-jcs-v1', value: row.draft_fingerprint as `sha256:${string}` },
    draft: lerJson<TaskDraft>(row.draft_document),
    reportId: row.report_id,
    reportFingerprint: { algorithm: 'sha256-jcs-v1', value: row.report_fingerprint as `sha256:${string}` },
    report: lerJson<TaskReadinessReport>(row.report_document),
    createdAt: row.created_at
  }
}

/**
 * Preflight no SQLite, com o mesmo comportamento do PostgresTaskStore. O BEGIN IMMEDIATE
 * serializa as escritas, então o FOR UPDATE do PostgreSQL não tem equivalente aqui.
 */
export class SqlitePreflightStore implements PreflightStore {
  constructor(protected readonly arquivo: string, protected readonly origemMaquina: string) {}

  protected ler<T>(trabalho: (db: DatabaseSync) => T): T {
    return comBanco(this.arquivo, trabalho)
  }

  protected escrever<T>(trabalho: (db: DatabaseSync) => T): T {
    return comBanco(this.arquivo, (db) => transacao(db, () => trabalho(db)))
  }

  /** Insere com as colunas da casa (ADR-023 D8) preenchidas por este processo. */
  protected inserir(db: DatabaseSync, tabela: string, linha: Linha): void {
    const completa: Linha = { ...linha, origem_maquina: this.origemMaquina }
    const colunas = Object.keys(completa)
    db.prepare(`INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${colunas.map(() => '?').join(', ')})`)
      .run(...Object.values(completa))
  }

  async findPreflightRevision(draftId: string, revision: number): Promise<StoredPreflightRevision | null> {
    return this.ler((db) => this.revisao(db, draftId, revision))
  }

  async findPreflightReport(reportId: string): Promise<TaskReadinessReport | null> {
    const row = this.ler((db) => db.prepare('SELECT report_document FROM overcore_preflight_revisions WHERE report_id = ?')
      .get(reportId) as { report_document: string } | undefined)
    return row ? lerJson<TaskReadinessReport>(row.report_document) : null
  }

  async findLatestPreflightByIdempotencyKey(idempotencyKey: string): Promise<StoredPreflightRevision | null> {
    const row = this.ler((db) => db.prepare(`SELECT r.* FROM overcore_preflight_streams s
      JOIN overcore_preflight_revisions r ON r.draft_id = s.draft_id AND r.revision = s.latest_revision
      WHERE s.idempotency_key = ?`).get(idempotencyKey) as PreflightRevisionRow | undefined)
    return row ? mapPreflight(row) : null
  }

  async appendPreflightRevision(record: StoredPreflightRevision, expectedPreviousRevision: number): Promise<StoredPreflightRevision> {
    if (record.revision !== expectedPreviousRevision + 1) {
      throw new Error('A revisão persistida precisa avançar exatamente uma posição.')
    }
    try {
      return this.escrever((db) => this.anexar(db, record, expectedPreviousRevision))
    } catch (error) {
      if (!unicidade(error)) throw error
      // Mesmo desfecho do PostgreSQL depois do 23505, relido fora da transação desfeita.
      const exact = await this.findPreflightRevision(record.draftId, record.revision)
      if (exact?.draftFingerprint.value === record.draftFingerprint.value) return exact
      const owner = this.dono(record.idempotencyKey)
      if (owner && owner !== record.draftId) throw new DuplicatePreflightIntentError(owner)
      throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
    }
  }

  private revisao(db: DatabaseSync, draftId: string, revision: number): StoredPreflightRevision | null {
    const row = db.prepare('SELECT * FROM overcore_preflight_revisions WHERE draft_id = ? AND revision = ?')
      .get(draftId, revision) as PreflightRevisionRow | undefined
    return row ? mapPreflight(row) : null
  }

  private dono(idempotencyKey: string): string | undefined {
    const row = this.ler((db) => db.prepare('SELECT draft_id FROM overcore_preflight_streams WHERE idempotency_key = ?')
      .get(idempotencyKey) as { draft_id: string } | undefined)
    return row?.draft_id
  }

  private anexar(db: DatabaseSync, record: StoredPreflightRevision, expectedPreviousRevision: number): StoredPreflightRevision {
    const exact = this.revisao(db, record.draftId, record.revision)
    if (exact) {
      if (exact.draftFingerprint.value !== record.draftFingerprint.value) {
        throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
      }
      return exact
    }
    const owner = db.prepare('SELECT draft_id FROM overcore_preflight_streams WHERE idempotency_key = ?')
      .get(record.idempotencyKey) as { draft_id: string } | undefined
    if (owner && owner.draft_id !== record.draftId) throw new DuplicatePreflightIntentError(owner.draft_id)

    const stream = db.prepare('SELECT idempotency_key, latest_revision FROM overcore_preflight_streams WHERE draft_id = ?')
      .get(record.draftId) as { idempotency_key: string; latest_revision: number } | undefined
    const createdAt = instante(record.createdAt)
    if (stream) {
      if (stream.idempotency_key !== record.idempotencyKey) throw new DuplicatePreflightIntentError(record.draftId)
      if (stream.latest_revision !== expectedPreviousRevision) {
        throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
      }
    } else {
      if (expectedPreviousRevision !== 0) throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
      this.inserir(db, 'overcore_preflight_streams', {
        draft_id: record.draftId, idempotency_key: record.idempotencyKey, latest_revision: record.revision,
        latest_report_id: record.reportId, status: record.report.status, created_at: createdAt, updated_at: createdAt
      })
    }

    this.inserir(db, 'overcore_preflight_revisions', {
      draft_id: record.draftId, revision: record.revision, idempotency_key: record.idempotencyKey,
      draft_fingerprint: record.draftFingerprint.value, draft_document: JSON.stringify(record.draft),
      report_id: record.reportId, report_fingerprint: record.reportFingerprint.value,
      report_document: JSON.stringify(record.report), status: record.report.status, created_at: createdAt
    })
    if (stream) {
      const updated = db.prepare(`UPDATE overcore_preflight_streams
        SET latest_revision = ?, latest_report_id = ?, status = ?, updated_at = ?,
            versao = versao + 1, atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE draft_id = ? AND latest_revision = ?`).run(
        record.revision, record.reportId, record.report.status, createdAt, record.draftId, expectedPreviousRevision)
      if (Number(updated.changes) !== 1) throw new ConcurrentPreflightUpdateError(record.draftId, expectedPreviousRevision)
    }
    const created = this.revisao(db, record.draftId, record.revision)
    if (!created) throw new Error('SQLite não devolveu a revisão de Preflight criada.')
    return created
  }
}
