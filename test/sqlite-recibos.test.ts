import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionReceipt } from '../src/domain/types.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import { avancar, bancoMigrado, emMinuto, evento, mensagem, minuto, tarefa } from './support/sqlite-fixtures.js'

const UM_MINUTO = 60_000
const DENTRO_DO_LEASE = new Date(emMinuto(1).getTime() + 10_000)

function recibo(digito = 'a', recordedAt = minuto(1)): ExecutionReceipt {
  return {
    receiptId: 'rec-o1', outboxId: 'o1', taskId: 't1', executionEpoch: 1,
    payload: { kind: 'inspection-completed', resultado: digito },
    payloadFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${digito.repeat(64)}` },
    recordedAt
  }
}

async function reivindicada(store: SqliteTaskStore): Promise<string> {
  const criada = await store.create(tarefa('t1'), evento('ev-t1'))
  await store.compareAndSwap(avancar(criada, 'running', { outbox: mensagem('o1', 't1', 0) }))
  const claim = await store.claimOutbox('w1', UM_MINUTO, emMinuto(1))
  assert.ok(claim)
  return claim.claimToken
}

test('o recibo grava sob lease válido e o replay devolve o mesmo', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const token = await reivindicada(store)
  assert.equal(await store.findExecutionReceipt('o1'), null)
  const salvo = await store.saveExecutionReceipt(recibo('a', '2026-11-05T09:01:00-03:00'), token, DENTRO_DO_LEASE)
  assert.deepEqual(salvo, recibo())
  assert.deepEqual(await store.saveExecutionReceipt(recibo(), token, DENTRO_DO_LEASE), recibo())
  assert.deepEqual(await store.saveExecutionReceipt({ ...recibo(), receiptId: 'rec-outro' }, token, DENTRO_DO_LEASE), recibo())
  assert.deepEqual(await new SqliteTaskStore(arquivo, 'maquina-teste').findExecutionReceipt('o1'), recibo())
})

test('conteúdo diferente para a mesma outbox é recusado', async () => {
  const store = new SqliteTaskStore(await bancoMigrado(), 'maquina-teste')
  const token = await reivindicada(store)
  await store.saveExecutionReceipt(recibo('a'), token, DENTRO_DO_LEASE)
  await assert.rejects(store.saveExecutionReceipt(recibo('b'), token, DENTRO_DO_LEASE), /Recibo da outbox o1 possui outro conteudo/)
  assert.deepEqual(await store.findExecutionReceipt('o1'), recibo('a'))
})

test('token errado, lease vencido ou mensagem fechada não gravam recibo', async () => {
  const store = new SqliteTaskStore(await bancoMigrado(), 'maquina-teste')
  const token = await reivindicada(store)
  const recusa = /Lease da outbox nao permite persistir o recibo de execucao/
  await assert.rejects(store.saveExecutionReceipt(recibo(), 'alheio', DENTRO_DO_LEASE), recusa)
  await assert.rejects(store.saveExecutionReceipt(recibo(), token, emMinuto(5)), recusa)
  await store.completeOutbox('o1', token)
  await assert.rejects(store.saveExecutionReceipt(recibo(), token, DENTRO_DO_LEASE), recusa)
  assert.equal(await store.findExecutionReceipt('o1'), null)
})
