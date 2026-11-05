import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { TaskDraft, TaskReadinessReport } from '../src/domain/types.js'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { aplicarMigracoes } from '../src/infrastructure/database/sqlite/migracoes.js'
import { SqlitePreflightStore } from '../src/infrastructure/database/sqlite/sqlite-preflight-store.js'
import {
  ConcurrentPreflightUpdateError,
  DuplicatePreflightIntentError,
  type StoredPreflightRevision
} from '../src/ports/preflight-store.js'

const pastas: string[] = []
after(async () => { await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true }))) })

async function bancoMigrado(): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-preflight-store-'))
  pastas.push(pasta)
  const arquivo = join(pasta, 'overcore.db')
  aplicarMigracoes(arquivo, join(process.cwd(), 'migrations-sqlite'))
  return arquivo
}

function revisao(draftId: string, revision: number, opcoes: { chave?: string; digito?: string; reportId?: string } = {}): StoredPreflightRevision {
  const idempotencyKey = opcoes.chave ?? `chave-${draftId}`
  const reportId = opcoes.reportId ?? `rep-${draftId}-${revision}`
  const valor = (digito: string) => `sha256:${digito.repeat(64)}` as `sha256:${string}`
  return {
    draftId, revision, idempotencyKey,
    draftFingerprint: { algorithm: 'sha256-jcs-v1', value: valor(opcoes.digito ?? String(revision % 10)) },
    draft: { draftId, revision, idempotencyKey, objective: 'teste' } as unknown as TaskDraft,
    reportId,
    reportFingerprint: { algorithm: 'sha256-jcs-v1', value: valor('f') },
    report: { reportId, draftId, draftRevision: revision, status: revision === 1 ? 'decisions-required' : 'ready', requiredDecisions: [] } as unknown as TaskReadinessReport,
    createdAt: `2026-11-05T12:0${revision}:00.000Z`
  }
}

test('grava, relê pelas três chaves e devolve a mesma revisão no replay', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqlitePreflightStore(arquivo, 'maquina-teste')
  const primeira = revisao('d1', 1)
  assert.deepEqual(await store.appendPreflightRevision(primeira, 0), primeira)
  assert.deepEqual(await store.appendPreflightRevision(primeira, 0), primeira)
  const reaberto = new SqlitePreflightStore(arquivo, 'maquina-teste')
  assert.deepEqual(await reaberto.findPreflightRevision('d1', 1), primeira)
  assert.deepEqual(await reaberto.findPreflightReport(primeira.reportId), primeira.report)
  assert.deepEqual(await reaberto.findLatestPreflightByIdempotencyKey('chave-d1'), primeira)
  assert.equal(await reaberto.findPreflightRevision('d1', 2), null)
  assert.equal(await reaberto.findPreflightReport('nao-existe'), null)
  assert.equal(await reaberto.findLatestPreflightByIdempotencyKey('nao-existe'), null)
})

test('a segunda revisão avança o stream e vira a mais recente, com a versão da linha no diário', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqlitePreflightStore(arquivo, 'maquina-teste')
  await store.appendPreflightRevision(revisao('d1', 1), 0)
  const segunda = revisao('d1', 2)
  await store.appendPreflightRevision(segunda, 1)
  assert.deepEqual(await store.findLatestPreflightByIdempotencyKey('chave-d1'), segunda)
  const stream = comBanco(arquivo, (db) => db.prepare('SELECT latest_revision, status, versao, origem_maquina FROM overcore_preflight_streams').get())
  assert.deepEqual({ ...stream }, { latest_revision: 2, status: 'ready', versao: 2, origem_maquina: 'maquina-teste' })
  const diario = comBanco(arquivo, (db) => db.prepare("SELECT operacao, versao FROM _diario WHERE tabela = 'overcore_preflight_streams' ORDER BY seq").all())
  assert.deepEqual(diario.map((linha) => [linha.operacao, linha.versao]), [['I', 1], ['U', 2]])
})

test('conteúdo diferente na mesma revisão e revisão anterior velha são concorrência', async () => {
  const store = new SqlitePreflightStore(await bancoMigrado(), 'maquina-teste')
  await store.appendPreflightRevision(revisao('d1', 1), 0)
  await assert.rejects(store.appendPreflightRevision(revisao('d1', 1, { digito: 'c' }), 0), ConcurrentPreflightUpdateError)
  await assert.rejects(store.appendPreflightRevision(revisao('d1', 3), 2), ConcurrentPreflightUpdateError)
  await assert.rejects(store.appendPreflightRevision(revisao('d2', 2), 1), ConcurrentPreflightUpdateError)
  await assert.rejects(store.appendPreflightRevision(revisao('d1', 3), 1), /precisa avançar exatamente uma posição/)
})

test('a chave idempotente pertence a um draft só', async () => {
  const store = new SqlitePreflightStore(await bancoMigrado(), 'maquina-teste')
  await store.appendPreflightRevision(revisao('d1', 1), 0)
  await assert.rejects(
    store.appendPreflightRevision(revisao('d2', 1, { chave: 'chave-d1' }), 0),
    (error: unknown) => error instanceof DuplicatePreflightIntentError && error.existingDraftId === 'd1'
  )
  await assert.rejects(
    store.appendPreflightRevision(revisao('d1', 2, { chave: 'outra' }), 1),
    (error: unknown) => error instanceof DuplicatePreflightIntentError && error.existingDraftId === 'd1'
  )
})

test('relatório repetido em outro draft vira concorrência e não deixa stream órfão', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqlitePreflightStore(arquivo, 'maquina-teste')
  await store.appendPreflightRevision(revisao('d1', 1), 0)
  await assert.rejects(store.appendPreflightRevision(revisao('d2', 1, { reportId: 'rep-d1-1' }), 0), ConcurrentPreflightUpdateError)
  assert.equal(await store.findLatestPreflightByIdempotencyKey('chave-d2'), null)
  assert.equal(Number(comBanco(arquivo, (db) => db.prepare('SELECT count(*) AS n FROM overcore_preflight_streams').get()?.n)), 1)
})
