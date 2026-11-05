import assert from 'node:assert/strict'
import { test } from 'node:test'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import { DuplicateTaskError } from '../src/ports/task-store.js'
import { minuto, sha } from './support/fixtures-de-tarefa.js'
import { avancar, bancoMigrado, evento, mensagem, tarefa } from './support/sqlite-fixtures.js'

// O comportamento da porta está no contrato (test/support/task-store-contract.ts); aqui fica só o que é do SQLite.

test('a tarefa grava a origem da máquina, e colisão fora das chaves de admissão sai como UNIQUE cru', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  await store.create(tarefa('t1'), evento('ev-t1-1'))
  const gravado = comBanco(arquivo, (db) => db.prepare('SELECT t.origem_maquina, e.kind FROM overcore_tasks t JOIN overcore_task_events e USING (task_id)').get())
  assert.deepEqual({ ...gravado }, { origem_maquina: 'maquina-teste', kind: 'teste' })
  await assert.rejects(store.create(tarefa('t3', { requestId: 'req-t1' }), evento('ev-t3-1')),
    (error: unknown) => !(error instanceof DuplicateTaskError) && /UNIQUE/.test(String(error)))
  await assert.rejects(store.create(tarefa('t1', { chave: 'outra' }), evento('ev-t1-x')), /UNIQUE/)
})

test('o CAS normaliza a expiração da autorização e cada revisão entra no diário', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const t1 = await store.create(tarefa('t1'), evento('ev-t1-1'))
  const plano = { planId: 'p1', planRevision: 1, planFingerprint: { algorithm: 'sha256-jcs-v1', value: sha('a') }, createdAt: minuto(1) }
  const t2 = await store.compareAndSwap(avancar(t1, 'planning', { plan: plano }))
  const autorizacao = {
    request: { authorizationRequestId: 'ar1', planBinding: { planId: 'p1', planRevision: 1 } },
    decision: { decisionId: 'dec1', limits: { expiresAt: '2026-11-05T09:30:00-03:00' } },
    enforcement: { enforcementId: 'enf1' }
  }
  await store.compareAndSwap(avancar(t2, 'running', { authorization: autorizacao, outbox: mensagem('o1', 't1', 2) }))
  const expira = comBanco(arquivo, (db) => db.prepare('SELECT expires_at FROM overcore_task_authorizations').get()?.expires_at)
  assert.equal(expira, '2026-11-05T12:30:00.000Z')
  const diario = comBanco(arquivo, (db) => db.prepare("SELECT operacao, versao FROM _diario WHERE tabela = 'overcore_tasks' ORDER BY seq").all())
  assert.deepEqual(diario.map((linha) => [linha.operacao, linha.versao]), [['I', 1], ['U', 2], ['U', 3]])
})
