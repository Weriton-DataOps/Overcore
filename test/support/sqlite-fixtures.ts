import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

import type { CasMutation, OutboxMessage, StoredTask, TaskRequest, TaskState, TaskStatus } from '../../src/domain/types.js'
import { comBanco } from '../../src/infrastructure/database/sqlite/banco.js'
import { aplicarMigracoes } from '../../src/infrastructure/database/sqlite/migracoes.js'

/** Fixtures dos testes do adaptador SQLite. Cada banco nasce numa pasta temporária própria. */

const pastas: string[] = []
after(async () => { await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true }))) })

export async function bancoMigrado(): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-sqlite-'))
  pastas.push(pasta)
  const arquivo = join(pasta, 'overcore.db')
  aplicarMigracoes(arquivo, join(process.cwd(), 'migrations-sqlite'))
  return arquivo
}

export function minuto(n: number): string {
  return new Date(Date.UTC(2026, 10, 5, 12, n)).toISOString()
}

export function emMinuto(n: number): Date {
  return new Date(minuto(n))
}

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

export function contar(arquivo: string, tabela: string): number {
  return Number(comBanco(arquivo, (db) => db.prepare(`SELECT count(*) AS n FROM ${tabela}`).get()?.n))
}
