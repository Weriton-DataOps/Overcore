import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { instante, lerJson, unicidade } from '../src/infrastructure/database/sqlite/mapeamento.js'
import { aplicarMigracoes } from '../src/infrastructure/database/sqlite/migracoes.js'

const AGORA = '2026-11-05T12:00:00.000Z'
const SHA = `sha256:${'b'.repeat(64)}`

const pastas: string[] = []
after(async () => { await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true }))) })

async function bancoMigrado(): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-mapeamento-'))
  pastas.push(pasta)
  const arquivo = join(pasta, 'overcore.db')
  aplicarMigracoes(arquivo, join(process.cwd(), 'migrations-sqlite'))
  return arquivo
}

function tarefa(db: DatabaseSync, taskId: string, requestId: string, idempotencyKey: string): void {
  db.prepare(`INSERT INTO overcore_tasks (task_id, request_id, idempotency_key, scope_key, status, state_revision,
    execution_epoch, request_document, state_document, created_at, updated_at, origem_maquina)
    VALUES (?, ?, ?, 's', 'accepted', 1, 1, '{}', ?, ?, ?, 'm')`).run(
    taskId, requestId, idempotencyKey, JSON.stringify({ taskId, stateRevision: 1, lifecycle: { state: 'accepted' } }), AGORA, AGORA)
}

function revisao(db: DatabaseSync, draftId: string, revision: number, reportId: string): void {
  db.prepare(`INSERT INTO overcore_preflight_revisions (draft_id, revision, idempotency_key, draft_fingerprint,
    draft_document, report_id, report_fingerprint, report_document, status, created_at, origem_maquina)
    VALUES (?, ?, 'k', ?, ?, ?, ?, ?, 'ready', ?, 'm')`).run(
    draftId, revision, SHA, JSON.stringify({ draftId, revision, idempotencyKey: 'k' }), reportId, SHA,
    JSON.stringify({ reportId, draftId, draftRevision: revision, status: 'ready' }), AGORA)
}

function colisao(arquivo: string, preparar: (db: DatabaseSync) => void, colidir: (db: DatabaseSync) => void) {
  return comBanco(arquivo, (db) => {
    preparar(db)
    try { colidir(db) } catch (error) { return unicidade(error) }
    assert.fail('a segunda escrita deveria colidir')
  })
}

test('cada chave única da tarefa gera o par tabela e colunas certo', async () => {
  const arquivo = await bancoMigrado()
  const base = (db: DatabaseSync) => tarefa(db, 't1', 'r1', 'k1')
  assert.deepEqual(colisao(arquivo, base, (db) => tarefa(db, 't1', 'r2', 'k2')), { tabela: 'overcore_tasks', colunas: ['task_id'] })
  comBanco(arquivo, (db) => db.exec('DELETE FROM overcore_tasks'))
  assert.deepEqual(colisao(arquivo, base, (db) => tarefa(db, 't2', 'r1', 'k2')), { tabela: 'overcore_tasks', colunas: ['request_id'] })
  comBanco(arquivo, (db) => db.exec('DELETE FROM overcore_tasks'))
  assert.deepEqual(colisao(arquivo, base, (db) => tarefa(db, 't2', 'r2', 'k1')), { tabela: 'overcore_tasks', colunas: ['idempotency_key'] })
})

test('chave composta devolve as colunas na ordem da chave', async () => {
  const arquivo = await bancoMigrado()
  const resultado = colisao(arquivo, (db) => {
    db.prepare(`INSERT INTO overcore_preflight_streams (draft_id, idempotency_key, latest_revision, latest_report_id,
      status, created_at, updated_at, origem_maquina) VALUES ('d1', 'k', 1, 'rep1', 'ready', ?, ?, 'm')`).run(AGORA, AGORA)
    revisao(db, 'd1', 1, 'rep1')
  }, (db) => revisao(db, 'd1', 1, 'rep2'))
  assert.deepEqual(resultado, { tabela: 'overcore_preflight_revisions', colunas: ['draft_id', 'revision'] })
})

test('erro que não é de unicidade não vira colisão', async () => {
  const arquivo = await bancoMigrado()
  const cheque = comBanco(arquivo, (db) => {
    try { tarefa(db, 't1', 'r1', 'k1'); db.exec("UPDATE overcore_tasks SET status = 'inexistente'") } catch (error) { return error }
    return undefined
  })
  assert.match(String((cheque as Error).message), /CHECK constraint failed/)
  assert.equal(unicidade(cheque), null)
  assert.equal(unicidade(new Error('UNIQUE constraint failed: overcore_tasks.task_id')), null)
  assert.equal(unicidade('texto'), null)
})

test('instante normaliza para o ISO de 24 caracteres e recusa valor inválido', () => {
  assert.equal(instante('2026-11-05T12:00:00Z'), AGORA)
  assert.equal(instante('2026-11-05T09:00:00-03:00'), AGORA)
  assert.equal(instante(new Date(AGORA)), AGORA)
  assert.throws(() => instante('ontem'), /Instante inválido: ontem/)
})

test('lerJson devolve objeto e recusa texto que não é objeto JSON', () => {
  assert.deepEqual(lerJson('{"a":[1,{"b":null}]}'), { a: [1, { b: null }] })
  assert.throws(() => lerJson('[1]'), /Documento JSON do banco não é um objeto/)
  assert.throws(() => lerJson('null'), /Documento JSON do banco não é um objeto/)
})
