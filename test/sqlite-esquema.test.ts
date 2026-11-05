import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { aplicarMigracoes } from '../src/infrastructure/database/sqlite/migracoes.js'

const raiz = process.cwd()
const MIGRACOES = join(raiz, 'migrations-sqlite')
const SHA = `sha256:${'a'.repeat(64)}`
const AGORA = '2026-11-05T12:00:00.000Z'

const pastas: string[] = []
after(async () => { await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true }))) })

async function bancoMigrado(): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-esquema-'))
  pastas.push(pasta)
  const arquivo = join(pasta, 'overcore.db')
  aplicarMigracoes(arquivo, MIGRACOES)
  return arquivo
}

function inserirTarefa(db: DatabaseSync, taskId: string, sobrescrever: Record<string, unknown> = {}): void {
  const estado = { taskId, stateRevision: 1, lifecycle: { state: 'accepted' } }
  const linha: Record<string, unknown> = {
    task_id: taskId,
    request_id: `req-${taskId}`,
    idempotency_key: `idem-${taskId}`,
    scope_key: 'escopo',
    status: 'accepted',
    state_revision: 1,
    execution_epoch: 1,
    request_document: '{}',
    state_document: JSON.stringify(estado),
    created_at: AGORA,
    updated_at: AGORA,
    origem_maquina: 'maquina-teste',
    ...sobrescrever
  }
  const colunas = Object.keys(linha)
  db.prepare(`INSERT INTO overcore_tasks (${colunas.join(', ')}) VALUES (${colunas.map(() => '?').join(', ')})`)
    .run(...(Object.values(linha) as Array<string | number | null>))
}

function inserirPreflight(db: DatabaseSync, draftId: string, fingerprint = SHA): void {
  db.prepare(`INSERT INTO overcore_preflight_streams
    (draft_id, idempotency_key, latest_revision, latest_report_id, status, created_at, updated_at, origem_maquina)
    VALUES (?, ?, 1, ?, 'ready', ?, ?, 'maquina-teste')`).run(draftId, `idem-${draftId}`, `rep-${draftId}`, AGORA, AGORA)
  db.prepare(`INSERT INTO overcore_preflight_revisions
    (draft_id, revision, idempotency_key, draft_fingerprint, draft_document, report_id, report_fingerprint,
     report_document, status, created_at, origem_maquina)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'ready', ?, 'maquina-teste')`).run(
    draftId, `idem-${draftId}`, fingerprint,
    JSON.stringify({ draftId, revision: 1, idempotencyKey: `idem-${draftId}` }),
    `rep-${draftId}`, SHA,
    JSON.stringify({ reportId: `rep-${draftId}`, draftId, draftRevision: 1, status: 'ready' }),
    AGORA
  )
}

function diario(db: DatabaseSync): Array<[string, string, string, number]> {
  return db.prepare('SELECT tabela, linha, operacao, versao FROM _diario ORDER BY seq').all()
    .map((linha) => [String(linha.tabela), String(linha.linha), String(linha.operacao), Number(linha.versao)])
}

test('0001 cria as tabelas do PostgreSQL 001–008, o _diario e o _dono', async () => {
  const tabelas = comBanco(await bancoMigrado(), (db) => db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((linha) => String(linha.name)))
  assert.deepEqual(tabelas, [
    '_diario', '_dono', '_migracoes',
    'overcore_effect_journal', 'overcore_preflight_revisions', 'overcore_preflight_streams',
    'overcore_task_authorizations', 'overcore_task_events', 'overcore_task_execution_receipts',
    'overcore_task_outbox', 'overcore_task_plans', 'overcore_tasks'
  ])
})

test('revisão de preflight é append-only no UPDATE e cai em cascata com o stream, como no PostgreSQL', async () => {
  const arquivo = await bancoMigrado()
  comBanco(arquivo, (db) => {
    inserirPreflight(db, 'd1')
    assert.throws(() => db.exec("UPDATE overcore_preflight_revisions SET status = 'not-feasible'"), /overcore_preflight_revisions is append-only/)
    db.exec("DELETE FROM overcore_preflight_streams WHERE draft_id = 'd1'")
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM overcore_preflight_revisions').get()?.n), 0)
  })
})

test('fingerprint fora de sha256:<64 hex minúsculos> é barrado', async () => {
  const arquivo = await bancoMigrado()
  comBanco(arquivo, (db) => {
    for (const [i, ruim] of [`sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `md5:${'a'.repeat(67)}`, `sha256:${'g'.repeat(64)}`].entries()) {
      assert.throws(() => inserirPreflight(db, `ruim-${i}`, ruim), /CHECK constraint failed/)
    }
  })
})

test('documento de estado precisa concordar com as colunas da tarefa', async () => {
  const arquivo = await bancoMigrado()
  comBanco(arquivo, (db) => {
    assert.throws(() => inserirTarefa(db, 't1', { status: 'ready' }), /CHECK constraint failed/)
    assert.throws(() => inserirTarefa(db, 't2', { state_revision: 2 }), /CHECK constraint failed/)
    assert.throws(() => inserirTarefa(db, 't3', { state_document: JSON.stringify({ taskId: 'outra', stateRevision: 1, lifecycle: { state: 'accepted' } }) }), /CHECK constraint failed/)
    assert.throws(() => inserirTarefa(db, 't4', { created_at: '2026-11-05 12:00:00' }), /CHECK constraint failed/)
    inserirTarefa(db, 't5')
  })
})

test('lease e falha de reconciliação são tudo ou nada', async () => {
  const arquivo = await bancoMigrado()
  comBanco(arquivo, (db) => {
    assert.throws(() => inserirTarefa(db, 't1', { reconciliation_owner: 'w1' }), /CHECK constraint failed/)
    assert.throws(() => inserirTarefa(db, 't2', { reconciliation_failure_count: 1 }), /CHECK constraint failed/)
    inserirTarefa(db, 't3', { reconciliation_owner: 'w1', reconciliation_token: 'tk', reconciliation_until: AGORA })
    inserirTarefa(db, 't4', {
      reconciliation_failure_count: 1,
      reconciliation_retry_at: AGORA,
      reconciliation_error_code: 'erro',
      reconciliation_error_fingerprint: 'fp',
      reconciliation_last_error_at: AGORA
    })
  })
})

test('chave estrangeira está ligada', async () => {
  const arquivo = await bancoMigrado()
  comBanco(arquivo, (db) => {
    assert.throws(() => db.prepare(`INSERT INTO overcore_task_events
      (event_id, task_id, state_revision, kind, payload, occurred_at, origem_maquina)
      VALUES ('e1', 'nao-existe', 1, 'k', '{}', ?, 'maquina-teste')`).run(AGORA), /FOREIGN KEY constraint failed/)
  })
})

test('o diário grava I, U e D e ignora UPDATE que não muda a versão', async () => {
  const arquivo = await bancoMigrado()
  comBanco(arquivo, (db) => {
    inserirTarefa(db, 't1')
    db.exec("UPDATE overcore_tasks SET scope_key = 'outro' WHERE task_id = 't1'")
    db.exec("UPDATE overcore_tasks SET scope_key = 'mais', versao = versao + 1 WHERE task_id = 't1'")
    db.exec("DELETE FROM overcore_tasks WHERE task_id = 't1'")
    inserirPreflight(db, 'd1')
    assert.deepEqual(diario(db), [
      ['overcore_tasks', 't1', 'I', 1],
      ['overcore_tasks', 't1', 'U', 2],
      ['overcore_tasks', 't1', 'D', 2],
      ['overcore_preflight_streams', 'd1', 'I', 1],
      ['overcore_preflight_revisions', 'd1:1', 'I', 1]
    ])
  })
})

test('tabela append-only não aceita versão diferente de 1', async () => {
  const arquivo = await bancoMigrado()
  comBanco(arquivo, (db) => {
    inserirTarefa(db, 't1')
    assert.throws(() => db.prepare(`INSERT INTO overcore_task_events
      (event_id, task_id, state_revision, kind, payload, occurred_at, origem_maquina, versao)
      VALUES ('e1', 't1', 1, 'k', '{}', ?, 'maquina-teste', 2)`).run(AGORA), /CHECK constraint failed/)
  })
})

test('_dono guarda no máximo uma linha', async () => {
  const arquivo = await bancoMigrado()
  comBanco(arquivo, (db) => {
    db.prepare("INSERT INTO _dono (id, processo, maquina, token, ate) VALUES (1, 'p', 'm', 'tk', ?)").run(AGORA)
    assert.throws(() => db.prepare("INSERT INTO _dono (id, processo, maquina, token, ate) VALUES (2, 'p', 'm', 'tk', ?)").run(AGORA), /CHECK constraint failed/)
  })
})
