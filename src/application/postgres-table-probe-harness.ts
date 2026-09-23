import type { Pool, PoolClient } from 'pg'

import { sha256, stableId } from '../domain/fingerprint.js'
import type { JsonObject } from '../domain/types.js'
import { guardedEffect, type ExecutionControl, type CancellationProjection } from '../ports/execution-control.js'
import type { EffectAuthorizationEvidence, EffectAuthorityGuard, EffectJournalRecord, EffectJournalStore } from '../ports/effect-journal-store.js'
import { EffectIntentConflictError, EffectStateUncertainError, type FileMutationAuthorization } from './file-effect-harness.js'
import { probeAbsenceDigest, probeCompletionDigest, probeIntentFingerprint } from './postgres-table-probe.js'

const REQUIRED_CONTROLS = ['checkpoint-before-mutation', 'verify-after-effect', 'reconcile-before-retry', 'revocation-check-before-effect'] as const
const TABLE_NAME = /^overcore_controlled_probe_[a-z0-9_]{8,64}$/

export interface PostgresTableProbeIntent {
  taskId: string
  effectKey: string
  resourceRef: string
  targetUri: string
  databaseName: 'overcore_test'
  tableName: string
  authorization: FileMutationAuthorization
}

export interface PostgresTableProbeResult {
  journal: EffectJournalRecord
  evidence: JsonObject
  effect: JsonObject
  taskResultProjection: { evidence: JsonObject[], artifacts: JsonObject[], effects: JsonObject[], checkpointArtifactRef: string }
  wrote: boolean
}

function quoteIdentifier(value: string): string {
  if (!TABLE_NAME.test(value)) throw new Error('Nome de tabela fora do prefixo controlado.')
  return `"${value}"`
}

export class PostgresTableProbeHarness {
  constructor(
    private readonly pool: Pool,
    private readonly journal: EffectJournalStore,
    private readonly authority: EffectAuthorityGuard,
    private readonly now: () => Date = () => new Date()
  ) {}

  async apply(intent: PostgresTableProbeIntent, control?: ExecutionControl): Promise<PostgresTableProbeResult> {
    await control?.assertActive()
    this.assertIntent(intent)
    const logicalFingerprint = probeIntentFingerprint(intent)
    let record = await this.journal.findEffect(intent.effectKey)
    const beforeDigest = probeAbsenceDigest(intent.tableName)
    const afterDigest = probeCompletionDigest(intent.tableName)
    if (!record) {
      await this.assertTargetDatabaseAndAbsence(intent.databaseName, intent.tableName)
      const at = this.now().toISOString()
      record = await guardedEffect(control, () => this.journal.reserveEffect({
        effectId: stableId('effect', intent.effectKey), effectKey: intent.effectKey, taskId: intent.taskId,
        resourceRef: intent.resourceRef, targetUri: intent.targetUri, operation: 'database.schema.modify',
        intentFingerprint: logicalFingerprint, beforeDigest, afterDigest,
        checkpointRef: stableId('checkpoint-postgres-probe', `${intent.taskId}:${intent.effectKey}`),
        checkpointUri: `postgres-probe://local/overcore_test/${intent.tableName}#absent`,
        checkpointDigest: beforeDigest, state: 'reserved', revision: 1, applyCount: 0, reservedAt: at, updatedAt: at
      }))
    }
    if (record.intentFingerprint.value !== logicalFingerprint.value) throw new EffectIntentConflictError(record.effectKey)
    const prior = record
    record = await guardedEffect(control, async () => {
      if (prior.state === 'unknown' || await this.tableExists(intent.databaseName, intent.tableName)) {
        if (prior.state !== 'unknown') await this.journal.transitionEffect({ effectKey: prior.effectKey, expectedRevision: prior.revision, expectedStates: [prior.state], nextState: 'unknown', updatedAt: this.now().toISOString(), lastObservedDigest: sha256(`present:${intent.tableName}`) })
        throw new EffectStateUncertainError(prior.effectKey)
      }
      if (prior.state === 'applying') return this.journal.transitionEffect({ effectKey: prior.effectKey, expectedRevision: prior.revision, expectedStates: ['applying'], nextState: 'not-applied', updatedAt: this.now().toISOString(), lastObservedDigest: beforeDigest })
      return prior
    })
    if (record.state === 'confirmed') return this.result(record, false)
    if (!['reserved', 'not-applied'].includes(record.state)) throw new EffectStateUncertainError(record.effectKey)
    if (Date.parse(intent.authorization.expiresAt) <= this.now().getTime()) throw new Error('A autorização do efeito expirou.')
    const authorizationEvidence = await this.authority.assertActive({
      taskId: record.taskId, effectKey: record.effectKey, effectId: record.effectId,
      resourceRef: record.resourceRef, targetUri: record.targetUri, operation: record.operation,
      intentFingerprint: record.intentFingerprint, enforcementId: intent.authorization.enforcementId,
      expiresAt: intent.authorization.expiresAt, requiredControls: intent.authorization.requiredControls,
      ...(intent.authorization.authorizationRequest ? { authorizationRequest: intent.authorization.authorizationRequest } : {}),
      ...(intent.authorization.actionId ? { actionId: intent.authorization.actionId } : {})
    })
    const prepared = record
    return guardedEffect(control, async () => {
      let record = prepared
      if (Date.parse(intent.authorization.expiresAt) <= this.now().getTime()) throw new Error('A autorização do efeito expirou.')
      record = await this.journal.transitionEffect({ effectKey: record.effectKey, expectedRevision: record.revision, expectedStates: ['reserved', 'not-applied'], nextState: 'applying', updatedAt: this.now().toISOString(), incrementApplyCount: true, lastObservedDigest: beforeDigest })
      try {
        await this.createVerifyDrop(intent.databaseName, intent.tableName)
      } catch (error) {
        const absent = !(await this.tableExists(intent.databaseName, intent.tableName))
        await this.journal.transitionEffect({ effectKey: record.effectKey, expectedRevision: record.revision, expectedStates: ['applying'], nextState: absent ? 'not-applied' : 'unknown', updatedAt: this.now().toISOString(), lastObservedDigest: absent ? beforeDigest : sha256(`present:${intent.tableName}`), lastErrorFingerprint: sha256(error instanceof Error ? `${error.name}:${error.message}` : String(error)) })
        throw error
      }
      if (await this.tableExists(intent.databaseName, intent.tableName)) {
        await this.journal.transitionEffect({ effectKey: record.effectKey, expectedRevision: record.revision, expectedStates: ['applying'], nextState: 'unknown', updatedAt: this.now().toISOString(), lastObservedDigest: sha256(`present:${intent.tableName}`) })
        throw new EffectStateUncertainError(record.effectKey)
      }
      const confirmedAt = this.now().toISOString()
      record = await this.journal.transitionEffect({ effectKey: record.effectKey, expectedRevision: record.revision, expectedStates: ['applying'], nextState: 'confirmed', updatedAt: confirmedAt, confirmedAt, lastObservedDigest: beforeDigest })
      return this.result(record, true, authorizationEvidence)
    })
  }

  async reconcileCancellation(input: { taskId: string; effectKey: string; targetUri: string; tableName: string }): Promise<CancellationProjection> {
    let record = await this.journal.findEffect(input.effectKey)
    if (!record) return { evidence: [], artifacts: [], effects: [] }
    if (record.taskId !== input.taskId || record.targetUri !== input.targetUri || !TABLE_NAME.test(input.tableName)) throw new Error('Sonda pertence a outro alvo ou tarefa.')
    const present = await this.tableExists('overcore_test', input.tableName)
    // Absence alone cannot prove whether a create/drop transaction committed before a crash.
    const nextState = present ? 'unknown' : record.state === 'confirmed' ? 'confirmed'
      : ['reserved', 'not-applied'].includes(record.state) ? 'not-applied' : 'unknown'
    if (record.state !== nextState || record.lastObservedDigest !== (present ? sha256(`present:${input.tableName}`) : record.beforeDigest)) record = await this.journal.transitionEffect({ effectKey: record.effectKey, expectedRevision: record.revision,
      expectedStates: [record.state], nextState, updatedAt: this.now().toISOString(),
      lastObservedDigest: present ? sha256(`present:${input.tableName}`) : record.beforeDigest })
    const projection = this.result(record, false).taskResultProjection
    projection.effects[0]!.status = record.state
    projection.evidence[0]!.summary = `Cancelamento: sonda reconciliada como ${record.state}; tabela ${present ? 'presente' : 'ausente'}.`
    return projection
  }

  private assertIntent(intent: PostgresTableProbeIntent): void {
    if (intent.databaseName !== 'overcore_test' || !TABLE_NAME.test(intent.tableName) || !intent.targetUri.startsWith('postgres:')) throw new Error('Sonda PostgreSQL fora do escopo controlado.')
    if (!intent.authorization.operations.includes('database.schema.modify') || !intent.authorization.operations.includes('database.schema.read')) throw new Error('A autorização não concede as operações PostgreSQL necessárias.')
    for (const control of REQUIRED_CONTROLS) if (!intent.authorization.requiredControls.includes(control)) throw new Error(`A autorização não exige o controle ${control}.`)
  }

  private async assertTargetDatabaseAndAbsence(databaseName: string, tableName: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      const database = await this.currentDatabase(client)
      if (database !== databaseName) throw new Error(`A sonda exige ${databaseName}; conexão recebida para ${database}.`)
      if (await this.tableExistsWith(client, tableName)) throw new EffectStateUncertainError(`postgres-table-probe:${tableName}`)
    } finally { client.release() }
  }

  private async tableExists(databaseName: string, tableName: string): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      if (await this.currentDatabase(client) !== databaseName) throw new Error(`A sonda exige ${databaseName}.`)
      return await this.tableExistsWith(client, tableName)
    } finally { client.release() }
  }

  private async currentDatabase(client: PoolClient): Promise<string> {
    return String((await client.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name ?? '')
  }

  private async tableExistsWith(client: PoolClient, tableName: string): Promise<boolean> {
    const row = (await client.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [`public.${tableName}`])).rows[0]
    return row?.name !== null && row?.name !== undefined
  }

  private async createVerifyDrop(databaseName: string, tableName: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      if (await this.currentDatabase(client) !== databaseName) throw new Error(`A sonda exige ${databaseName}.`)
      await client.query('BEGIN')
      try {
        await client.query(`CREATE TABLE ${quoteIdentifier(tableName)} (probe_id integer PRIMARY KEY)`)
        if (!(await this.tableExistsWith(client, tableName))) throw new Error('A tabela temporária não apareceu após CREATE TABLE.')
        await client.query(`DROP TABLE ${quoteIdentifier(tableName)}`)
        if (await this.tableExistsWith(client, tableName)) throw new Error('A tabela temporária persistiu após DROP TABLE.')
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    } finally { client.release() }
  }

  private result(record: EffectJournalRecord, wrote: boolean, authorizationEvidence?: EffectAuthorizationEvidence): PostgresTableProbeResult {
    const capturedAt = record.confirmedAt ?? record.updatedAt
    const evidenceId = stableId('evidence-postgres-table-probe', `${record.effectId}:${record.revision}`)
    const evidence: JsonObject = { evidenceId, kind: 'state-readback', capturedAt, summary: wrote ? 'A tabela temporária foi criada, confirmada, removida e confirmada ausente na mesma transação.' : 'A sonda já estava concluída e a ausência final da tabela foi confirmada.', digest: record.lastObservedDigest ?? record.beforeDigest, artifactRefs: [record.checkpointRef], origin: { kind: 'executor', id: 'overcore-postgres-table-probe-v1' } }
    const authorizationDocument: JsonObject | undefined = authorizationEvidence ? { evidenceId: authorizationEvidence.evidenceId, kind: 'external-receipt', capturedAt: authorizationEvidence.checkedAt, summary: 'A autoridade foi revalidada imediatamente antes da operação PostgreSQL.', digest: authorizationEvidence.digest, artifactRefs: [], origin: { kind: 'external', id: 'omni-authority-provider' } } : undefined
    const effect: JsonObject = { effectId: record.effectId, effectKey: record.effectKey, intentFingerprint: record.intentFingerprint, resourceRef: record.resourceRef, operation: record.operation, status: 'confirmed', evidenceRefs: [evidenceId, ...(authorizationDocument ? [String(authorizationDocument.evidenceId)] : [])] }
    const artifact: JsonObject = { artifactId: record.checkpointRef, kind: 'checkpoint', uri: record.checkpointUri, digest: record.checkpointDigest, mediaType: 'application/json', sensitivity: 'internal', createdAt: record.reservedAt }
    return { journal: record, evidence, effect, taskResultProjection: { evidence: [evidence, ...(authorizationDocument ? [authorizationDocument] : [])], artifacts: [artifact], effects: [effect], checkpointArtifactRef: record.checkpointRef }, wrote }
  }
}
