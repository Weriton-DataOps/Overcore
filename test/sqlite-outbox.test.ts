import assert from 'node:assert/strict'
import { test } from 'node:test'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import { avancar, bancoMigrado, emMinuto, evento, mensagem, minuto, tarefa } from './support/sqlite-fixtures.js'

// O comportamento da porta está no contrato (test/support/task-store-contract.ts); aqui fica só o que é do SQLite.

const UM_MINUTO = 60_000

test('cada passo do lease da outbox avança a versão da linha e o release grava erro e retry', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const criada = await store.create(tarefa('t1'), evento('ev-t1'))
  await store.compareAndSwap(avancar(criada, 'running', { outbox: mensagem('o1', 't1', 0) }))
  const claim = await store.claimOutbox('w1', UM_MINUTO, emMinuto(1))
  assert.ok(claim)
  await store.extendOutboxLease('o1', claim.claimToken, UM_MINUTO, new Date(emMinuto(1).getTime() + 30_000))
  await store.releaseOutbox('o1', claim.claimToken, 'fp-erro', emMinuto(10))
  await store.claimOutbox('w2', UM_MINUTO, emMinuto(10))
  const linha = comBanco(arquivo, (db) => db.prepare('SELECT last_error_fingerprint, available_at, versao FROM overcore_task_outbox').get())
  assert.deepEqual({ ...linha }, { last_error_fingerprint: 'fp-erro', available_at: minuto(10), versao: 5 })
})

test('o CAS para fora da reconciliação zera as colunas do lease e da falha', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const t2 = await store.create(tarefa('t2'), evento('ev-t2'))
  const token = await store.claimReconciliation('t2', 'r1', UM_MINUTO, emMinuto(1))
  assert.ok(token)
  await store.deferReconciliation('t2', token, { code: 'X', errorFingerprint: 'fp', occurredAt: emMinuto(2), retryAt: emMinuto(10) })
  await store.compareAndSwap(avancar(t2, 'running'))
  const limpa = comBanco(arquivo, (db) => db.prepare(`SELECT reconciliation_token, reconciliation_failure_count, reconciliation_retry_at
    FROM overcore_tasks WHERE task_id = 't2'`).get())
  assert.deepEqual({ ...limpa }, { reconciliation_token: null, reconciliation_failure_count: 0, reconciliation_retry_at: null })
})
