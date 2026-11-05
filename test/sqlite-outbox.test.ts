import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StoredTask } from '../src/domain/types.js'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import { avancar, bancoMigrado, emMinuto, evento, mensagem, minuto, tarefa } from './support/sqlite-fixtures.js'

const UM_MINUTO = 60_000

/** Cria uma tarefa por mensagem e grava a mensagem pelo CAS, na ordem dada. */
async function comMensagens(store: SqliteTaskStore, mensagens: Array<[outboxId: string, disponivelNoMinuto: number]>): Promise<void> {
  for (const [outboxId, disponivel] of mensagens) {
    const taskId = `t-${outboxId}`
    const criada = await store.create(tarefa(taskId), evento(`ev-${taskId}`))
    await store.compareAndSwap(avancar(criada, 'running', { outbox: mensagem(outboxId, taskId, disponivel) }))
  }
}

test('reivindica pela ordem de disponibilidade e ignora o que ainda não venceu', async () => {
  const store = new SqliteTaskStore(await bancoMigrado(), 'maquina-teste')
  await comMensagens(store, [['o1', 5], ['o2', 1], ['o3', 1]])
  assert.equal(await store.claimOutbox('w1', UM_MINUTO, emMinuto(0)), null)
  const primeira = await store.claimOutbox('w1', UM_MINUTO, emMinuto(3))
  assert.equal(primeira?.outboxId, 'o2')
  assert.equal(primeira?.attempts, 1)
  assert.equal(primeira?.lockedUntil, minuto(4))
  assert.match(primeira?.claimToken ?? '', /^w1:/)
  assert.deepEqual(primeira?.payload, { outboxId: 'o2' })
  assert.equal((await store.claimOutbox('w1', UM_MINUTO, emMinuto(3)))?.outboxId, 'o3')
  assert.equal(await store.claimOutbox('w1', UM_MINUTO, emMinuto(3)), null)
})

test('lease vencido é reivindicado de novo e o token velho perde o direito', async () => {
  const store = new SqliteTaskStore(await bancoMigrado(), 'maquina-teste')
  await comMensagens(store, [['o1', 0]])
  const velha = await store.claimOutbox('w1', UM_MINUTO, emMinuto(1))
  assert.ok(velha)
  assert.equal(await store.claimOutbox('w2', UM_MINUTO, new Date(emMinuto(1).getTime() + 30_000)), null)
  const nova = await store.claimOutbox('w2', UM_MINUTO, emMinuto(2))
  assert.equal(nova?.outboxId, 'o1')
  assert.equal(nova?.attempts, 2)
  assert.notEqual(nova?.claimToken, velha.claimToken)
  await assert.rejects(store.completeOutbox('o1', velha.claimToken), /Lease da outbox não confere/)
  await assert.rejects(store.extendOutboxLease('o1', velha.claimToken, UM_MINUTO, emMinuto(2)), /Lease da outbox nao pode ser renovado/)
  await store.completeOutbox('o1', nova?.claimToken ?? '')
  await assert.rejects(store.completeOutbox('o1', nova?.claimToken ?? ''), /Lease da outbox não confere/)
  assert.equal(await store.claimOutbox('w3', UM_MINUTO, emMinuto(10)), null)
})

test('renovar estende o lease; soltar com token errado falha e soltar certo respeita o retryAt', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  await comMensagens(store, [['o1', 0]])
  const claim = await store.claimOutbox('w1', UM_MINUTO, emMinuto(1))
  assert.ok(claim)
  await store.extendOutboxLease('o1', claim.claimToken, UM_MINUTO, new Date(emMinuto(1).getTime() + 30_000))
  assert.equal(await store.claimOutbox('w2', UM_MINUTO, emMinuto(2)), null)
  await assert.rejects(store.extendOutboxLease('o1', claim.claimToken, UM_MINUTO, emMinuto(3)), /Lease da outbox nao pode ser renovado/)
  await assert.rejects(store.releaseOutbox('o1', 'alheio', 'fp', emMinuto(10)), /Lease da outbox não confere/)
  await store.releaseOutbox('o1', claim.claimToken, 'fp-erro', emMinuto(10))
  assert.equal(await store.claimOutbox('w2', UM_MINUTO, emMinuto(9)), null)
  const depois = await store.claimOutbox('w2', UM_MINUTO, emMinuto(10))
  assert.equal(depois?.attempts, 2)
  const linha = comBanco(arquivo, (db) => db.prepare('SELECT last_error_fingerprint, available_at, versao FROM overcore_task_outbox').get())
  assert.deepEqual({ ...linha }, { last_error_fingerprint: 'fp-erro', available_at: minuto(10), versao: 5 })
})

test('reconciliação: candidatos em ordem, posse exclusiva, adiamento com retry e soltura', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  for (const id of ['t3', 't1', 't2']) await store.create(tarefa(id), evento(`ev-${id}`))
  await store.create(tarefa('t4', { status: 'running' }), evento('ev-t4'))
  await store.create(tarefa('t5', { status: 'cancelling' }), evento('ev-t5'))
  const ids = (lista: StoredTask[]) => lista.map((t) => t.taskId)
  assert.deepEqual(ids(await store.listReconciliationCandidates(10, emMinuto(1))), ['t1', 't2', 't3', 't5'])
  assert.deepEqual(ids(await store.listReconciliationCandidates(2, emMinuto(1))), ['t1', 't2'])
  assert.equal(await store.claimReconciliation('t5', 'r1', UM_MINUTO, emMinuto(1)), null)
  assert.equal(await store.claimReconciliation('t4', 'r1', UM_MINUTO, emMinuto(1)), null)

  const velho = await store.claimReconciliation('t1', 'r1', UM_MINUTO, emMinuto(1))
  assert.match(velho ?? '', /^r1:/)
  assert.equal(await store.claimReconciliation('t1', 'r2', UM_MINUTO, emMinuto(1)), null)
  assert.deepEqual(ids(await store.listReconciliationCandidates(10, emMinuto(1))), ['t2', 't3', 't5'])
  const token = await store.claimReconciliation('t1', 'r2', UM_MINUTO, emMinuto(2))
  assert.ok(token && token !== velho)

  const falha = { code: 'X', errorFingerprint: 'fp', occurredAt: emMinuto(2), retryAt: emMinuto(10) }
  await assert.rejects(store.deferReconciliation('t1', velho ?? '', falha), /Lease da reconciliação não confere ao adiar a tarefa/)
  await store.deferReconciliation('t1', token, falha)
  assert.deepEqual((await store.findById('t1'))?.reconciliation,
    { failureCount: 1, retryAt: minuto(10), errorCode: 'X', errorFingerprint: 'fp', lastErrorAt: minuto(2) })
  assert.ok(!ids(await store.listReconciliationCandidates(10, emMinuto(5))).includes('t1'))
  assert.equal(await store.claimReconciliation('t1', 'r3', UM_MINUTO, emMinuto(5)), null)
  const outro = await store.claimReconciliation('t1', 'r3', UM_MINUTO, emMinuto(10))
  assert.ok(outro)
  await store.deferReconciliation('t1', outro, { ...falha, retryAt: emMinuto(20) })
  assert.equal((await store.findById('t1'))?.reconciliation?.failureCount, 2)
  const ultimo = await store.claimReconciliation('t1', 'r3', UM_MINUTO, emMinuto(20))
  await store.releaseReconciliation('t1', 'alheio')
  assert.equal((await store.findById('t1'))?.reconciliation?.failureCount, 2)
  await store.releaseReconciliation('t1', ultimo ?? '')
  assert.equal((await store.findById('t1'))?.reconciliation, undefined)

  const t2 = await store.findById('t2')
  assert.ok(t2 && await store.claimReconciliation('t2', 'r1', UM_MINUTO, emMinuto(1)))
  await store.deferReconciliation('t2', (comBanco(arquivo, (db) => db.prepare("SELECT reconciliation_token AS t FROM overcore_tasks WHERE task_id = 't2'").get()?.t) as string), falha)
  await store.compareAndSwap(avancar(t2, 'running'))
  const limpa = comBanco(arquivo, (db) => db.prepare(`SELECT reconciliation_token, reconciliation_failure_count, reconciliation_retry_at
    FROM overcore_tasks WHERE task_id = 't2'`).get())
  assert.deepEqual({ ...limpa }, { reconciliation_token: null, reconciliation_failure_count: 0, reconciliation_retry_at: null })
})
