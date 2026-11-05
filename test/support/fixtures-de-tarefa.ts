import type {
  CasMutation, ExecutionReceipt, OutboxMessage, StoredTask, TaskDraft, TaskReadinessReport, TaskRequest, TaskState, TaskStatus
} from '../../src/domain/types.js'
import type { EffectJournalRecord } from '../../src/ports/effect-journal-store.js'
import type { StoredPreflightRevision } from '../../src/ports/preflight-store.js'

/** Fixtures neutras de motor: valem para o in-memory, o SQLite e o PostgreSQL. As horas são fixas em 2026-11-05T12:nn. */

export function minuto(n: number): string {
  return new Date(Date.UTC(2026, 10, 5, 12, n)).toISOString()
}

export function emMinuto(n: number): Date {
  return new Date(minuto(n))
}

export const sha = (digito: string) => `sha256:${digito.repeat(64)}` as `sha256:${string}`

export function tarefa(taskId: string, opcoes: { chave?: string; requestId?: string; status?: TaskStatus; revisao?: number; epoca?: number } = {}): StoredTask {
  const status = opcoes.status ?? 'accepted'
  const stateRevision = opcoes.revisao ?? 1
  return {
    taskId,
    requestId: opcoes.requestId ?? `req-${taskId}`,
    idempotencyKey: opcoes.chave ?? `chave-${taskId}`,
    scopeKey: 'escopo',
    status,
    stateRevision,
    executionEpoch: opcoes.epoca ?? 1,
    request: { requestId: opcoes.requestId ?? `req-${taskId}`, objective: 'teste' } as unknown as TaskRequest,
    state: { taskId, stateRevision, lifecycle: { state: status } } as unknown as TaskState,
    createdAt: minuto(0),
    updatedAt: minuto(stateRevision - 1)
  }
}

export function evento(id: string, n = 0): CasMutation['event'] {
  return { eventId: id, kind: 'teste', payload: { n }, occurredAt: minuto(n) }
}

export function avancar(atual: StoredTask, status: TaskStatus, extra: Partial<CasMutation> = {}): CasMutation {
  const next = tarefa(atual.taskId, { chave: atual.idempotencyKey, requestId: atual.requestId, status, revisao: atual.stateRevision + 1, epoca: atual.executionEpoch })
  return { expectedRevision: atual.stateRevision, next, event: evento(`ev-${atual.taskId}-${next.stateRevision}`, next.stateRevision - 1), ...extra }
}

export function mensagem(outboxId: string, taskId: string, disponivelNoMinuto: number): OutboxMessage {
  return { outboxId, taskId, kind: 'execute-inspection', payload: { outboxId }, availableAt: minuto(disponivelNoMinuto), attempts: 0 }
}

export function revisao(draftId: string, revision: number, opcoes: { chave?: string; digito?: string; reportId?: string } = {}): StoredPreflightRevision {
  const idempotencyKey = opcoes.chave ?? `chave-${draftId}`
  const reportId = opcoes.reportId ?? `rep-${draftId}-${revision}`
  return {
    draftId, revision, idempotencyKey,
    draftFingerprint: { algorithm: 'sha256-jcs-v1', value: sha(opcoes.digito ?? String(revision % 10)) },
    draft: { draftId, revision, idempotencyKey, objective: 'teste' } as unknown as TaskDraft,
    reportId,
    reportFingerprint: { algorithm: 'sha256-jcs-v1', value: sha('f') },
    report: { reportId, draftId, draftRevision: revision, status: revision === 1 ? 'decisions-required' : 'ready', requiredDecisions: [] } as unknown as TaskReadinessReport,
    createdAt: minuto(revision)
  }
}

export function reserva(effectKey: string, effectId = `id-${effectKey}`): EffectJournalRecord {
  return {
    effectId, effectKey, taskId: 't1', resourceRef: 'arquivo:a', targetUri: 'file:///tmp/a', operation: 'filesystem.modify',
    intentFingerprint: { algorithm: 'sha256-jcs-v1', value: sha('1') },
    beforeDigest: sha('2'), afterDigest: sha('3'),
    checkpointRef: 'cp1', checkpointUri: 'file:///tmp/cp1', checkpointDigest: sha('4'),
    state: 'reserved', revision: 1, applyCount: 0, reservedAt: minuto(0), updatedAt: minuto(0)
  }
}

export function recibo(digito = 'a', recordedAt = minuto(1)): ExecutionReceipt {
  return {
    receiptId: 'rec-o1', outboxId: 'o1', taskId: 't1', executionEpoch: 1,
    payload: { kind: 'inspection-completed', resultado: digito },
    payloadFingerprint: { algorithm: 'sha256-jcs-v1', value: sha(digito) },
    recordedAt
  }
}
