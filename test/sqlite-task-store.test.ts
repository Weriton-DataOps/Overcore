import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JsonObject } from '../src/domain/types.js'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import { ConcurrentTaskUpdateError, DuplicateTaskError } from '../src/ports/task-store.js'
import { avancar, bancoMigrado, contar, evento, minuto, tarefa } from './support/sqlite-fixtures.js'

test('cria a tarefa com o evento e relê pelas duas chaves', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const t1 = tarefa('t1')
  assert.deepEqual(await store.create(t1, evento('ev-t1-1')), t1)
  const reaberto = new SqliteTaskStore(arquivo, 'maquina-teste')
  assert.deepEqual(await reaberto.findById('t1'), t1)
  assert.deepEqual(await reaberto.findByIdempotencyKey('chave-t1'), t1)
  assert.equal(await reaberto.findById('nao-existe'), null)
  assert.equal(await reaberto.findByIdempotencyKey('nao-existe'), null)
  const gravado = comBanco(arquivo, (db) => db.prepare('SELECT t.origem_maquina, e.kind FROM overcore_tasks t JOIN overcore_task_events e USING (task_id)').get())
  assert.deepEqual({ ...gravado }, { origem_maquina: 'maquina-teste', kind: 'teste' })
})

test('admissão repetida aponta a tarefa existente e não grava evento de novo', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  await store.create(tarefa('t1'), evento('ev-t1-1'))
  const duplicada = (error: unknown) => error instanceof DuplicateTaskError && error.existingTaskId === 't1'
  await assert.rejects(store.create(tarefa('t1'), evento('ev-t1-1b')), duplicada)
  await assert.rejects(store.create(tarefa('t2', { chave: 'chave-t1' }), evento('ev-t2-1')), duplicada)
  await assert.rejects(store.create(tarefa('t3', { requestId: 'req-t1' }), evento('ev-t3-1')),
    (error: unknown) => !(error instanceof DuplicateTaskError) && /UNIQUE/.test(String(error)))
  assert.equal(contar(arquivo, 'overcore_task_events'), 1)
  assert.equal(contar(arquivo, 'overcore_tasks'), 1)
})

test('o CAS avança a tarefa e grava plano, autorização, evento e outbox juntos', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const t1 = await store.create(tarefa('t1'), evento('ev-t1-1'))
  const plano: JsonObject = { planId: 'p1', planRevision: 1, planFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'a'.repeat(64)}` }, createdAt: minuto(1) }
  const t2 = await store.compareAndSwap(avancar(t1, 'planning', { plan: plano }))
  assert.equal(t2.stateRevision, 2)
  assert.deepEqual(await store.findPlan('t1', 'p1', 1), plano)
  assert.equal(await store.findPlan('t1', 'p1', 2), null)

  const autorizacao = {
    request: { authorizationRequestId: 'ar1', planBinding: { planId: 'p1', planRevision: 1 } },
    decision: { decisionId: 'dec1', limits: { expiresAt: '2026-11-05T09:30:00-03:00' } },
    enforcement: { enforcementId: 'enf1' }
  }
  const outbox = { outboxId: 'o1', taskId: 't1', kind: 'execute-inspection' as const, payload: { x: 1 }, availableAt: minuto(2), attempts: 0 }
  const t3 = await store.compareAndSwap(avancar(t2, 'running', { authorization: autorizacao, outbox }))
  assert.deepEqual(await store.findById('t1'), t3)
  assert.deepEqual(await store.findAuthorization('t1', 'dec1'), autorizacao)
  assert.equal(await store.findAuthorization('t1', 'outra'), null)
  const expira = comBanco(arquivo, (db) => db.prepare('SELECT expires_at FROM overcore_task_authorizations').get()?.expires_at)
  assert.equal(expira, '2026-11-05T12:30:00.000Z')
  assert.equal(contar(arquivo, 'overcore_task_events'), 3)
  assert.equal(contar(arquivo, 'overcore_task_outbox'), 1)
  const diario = comBanco(arquivo, (db) => db.prepare("SELECT operacao, versao FROM _diario WHERE tabela = 'overcore_tasks' ORDER BY seq").all())
  assert.deepEqual(diario.map((linha) => [linha.operacao, linha.versao]), [['I', 1], ['U', 2], ['U', 3]])
})

test('CAS com revisão velha ou que pula revisão falha sem mexer na tarefa', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const t1 = await store.create(tarefa('t1'), evento('ev-t1-1'))
  const t2 = await store.compareAndSwap(avancar(t1, 'planning'))
  await assert.rejects(store.compareAndSwap(avancar(t1, 'ready')), ConcurrentTaskUpdateError)
  await assert.rejects(store.compareAndSwap({ ...avancar(t2, 'ready'), expectedRevision: 1 }), /CAS precisa avançar exatamente uma revisão/)
  assert.deepEqual(await store.findById('t1'), t2)
  assert.equal(contar(arquivo, 'overcore_task_events'), 2)
})

test('falha no meio do CAS desfaz a tarefa, o evento e a outbox', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const t1 = await store.create(tarefa('t1'), evento('ev-t1-1'))
  const outbox = { outboxId: 'o1', taskId: 't1', kind: 'execute-inspection' as const, payload: {}, availableAt: minuto(1), attempts: 0 }
  const t2 = await store.compareAndSwap(avancar(t1, 'planning', { outbox }))
  await assert.rejects(store.compareAndSwap(avancar(t2, 'ready', { outbox })), /UNIQUE/)
  await assert.rejects(store.compareAndSwap(avancar(t2, 'ready', { completeOutbox: { outboxId: 'o1', claimToken: 'alheio' } })),
    /Lease da outbox não confere no fechamento transacional/)
  assert.deepEqual(await store.findById('t1'), t2)
  assert.equal(contar(arquivo, 'overcore_task_events'), 2)
  assert.equal(contar(arquivo, 'overcore_task_outbox'), 1)
})
