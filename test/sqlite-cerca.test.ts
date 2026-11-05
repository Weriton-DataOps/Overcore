import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClaimedMessage, StoredTask } from '../src/domain/types.js'
import { comBanco, transacao } from '../src/infrastructure/database/sqlite/banco.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import { ExecutionInterruptedError } from '../src/ports/execution-control.js'
import { avancar, bancoMigrado, emMinuto, evento, mensagem, tarefa } from './support/sqlite-fixtures.js'

const UM_MINUTO = 60_000
const DENTRO_DO_LEASE = new Date(emMinuto(1).getTime() + 10_000)

function adiado(): { promessa: Promise<void>; soltar: () => void } {
  let soltar!: () => void
  const promessa = new Promise<void>((resolve) => { soltar = resolve })
  return { promessa, soltar }
}

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Tarefa em execução com a mensagem dela reivindicada no minuto 1, lease de um minuto. */
async function emExecucao(store: SqliteTaskStore, taskId: string, outboxId: string): Promise<{ tarefa: StoredTask; claim: ClaimedMessage }> {
  const criada = await store.create(tarefa(taskId), evento(`ev-${taskId}`))
  const rodando = await store.compareAndSwap(avancar(criada, 'running', { outbox: mensagem(outboxId, taskId, 0) }))
  const claim = await store.claimOutbox('w1', UM_MINUTO, emMinuto(1))
  assert.equal(claim?.outboxId, outboxId)
  return { tarefa: rodando, claim }
}

test('a operação roda sem transação aberta e devolve o valor dela', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const { claim } = await emExecucao(store, 't1', 'o1')
  const valor = await store.withExecutionFence(claim, 1, 'execute', async () => {
    const inicio = Date.now()
    comBanco(arquivo, (db) => transacao(db, () => db.prepare("UPDATE overcore_tasks SET scope_key = 'outro' WHERE task_id = 'nada'").run()))
    await store.extendOutboxLease('o1', claim.claimToken, UM_MINUTO, DENTRO_DO_LEASE)
    return Date.now() - inicio
  }, DENTRO_DO_LEASE)
  assert.ok(valor < 1_000, `a escrita paralela esperou ${valor} ms: a cerca está segurando transação`)
})

test('época, estado, token, lease vencido ou mensagem fechada interrompem sem rodar a operação', async () => {
  const store = new SqliteTaskStore(await bancoMigrado(), 'maquina-teste')
  const { tarefa: rodando, claim } = await emExecucao(store, 't1', 'o1')
  let rodou = 0
  const operacao = async () => { rodou += 1 }
  for (const [claimUsado, epoca, modo, agora] of [
    [claim, 2, 'execute', DENTRO_DO_LEASE],
    [claim, 1, 'reconcile', DENTRO_DO_LEASE],
    [{ ...claim, claimToken: 'alheio' }, 1, 'execute', DENTRO_DO_LEASE],
    [{ ...claim, taskId: 'outra' }, 1, 'execute', DENTRO_DO_LEASE],
    [claim, 1, 'execute', emMinuto(5)]
  ] as const) {
    await assert.rejects(store.withExecutionFence(claimUsado, epoca, modo, operacao, agora), ExecutionInterruptedError)
  }
  assert.equal(rodou, 0)

  const cancelando = await store.compareAndSwap(avancar(rodando, 'cancelling'))
  await assert.rejects(store.withExecutionFence(claim, 1, 'execute', operacao, DENTRO_DO_LEASE), ExecutionInterruptedError)
  await store.withExecutionFence(claim, cancelando.executionEpoch, 'reconcile', operacao, DENTRO_DO_LEASE)
  assert.equal(rodou, 1)
  await store.completeOutbox('o1', claim.claimToken)
  await assert.rejects(store.withExecutionFence(claim, 1, 'reconcile', operacao, DENTRO_DO_LEASE), ExecutionInterruptedError)
  assert.equal(rodou, 1)
})

test('o CAS da mesma tarefa espera a cerca; o de outra tarefa passa', async () => {
  const store = new SqliteTaskStore(await bancoMigrado(), 'maquina-teste')
  const { tarefa: t1, claim } = await emExecucao(store, 't1', 'o1')
  const u1 = await store.create(tarefa('u1'), evento('ev-u1'))
  const ordem: string[] = []
  const portao = adiado()
  const cerca = store.withExecutionFence(claim, 1, 'execute', async () => {
    await portao.promessa
    ordem.push('operação')
    return 'feito'
  }, DENTRO_DO_LEASE)
  await esperar(20)
  const cas = store.compareAndSwap(avancar(t1, 'cancelling')).then((tarefaNova) => { ordem.push('cas'); return tarefaNova })
  await store.compareAndSwap(avancar(u1, 'planning'))
  await esperar(50)
  assert.deepEqual(ordem, [])
  portao.soltar()
  assert.equal(await cerca, 'feito')
  assert.equal((await cas).status, 'cancelling')
  assert.deepEqual(ordem, ['operação', 'cas'])
})

test('claimOutbox não pega mensagem em cerca, nem com o lease vencido, e volta a pegar depois', async () => {
  const store = new SqliteTaskStore(await bancoMigrado(), 'maquina-teste')
  const { claim } = await emExecucao(store, 't1', 'o1')
  const outra = await store.create(tarefa('t2'), evento('ev-t2'))
  await store.compareAndSwap(avancar(outra, 'running', { outbox: mensagem('o2', 't2', 0) }))
  const portao = adiado()
  const cerca = store.withExecutionFence(claim, 1, 'execute', () => portao.promessa, DENTRO_DO_LEASE)
  await esperar(20)
  assert.equal((await store.claimOutbox('w2', UM_MINUTO, emMinuto(30)))?.outboxId, 'o2')
  assert.equal(await store.claimOutbox('w2', UM_MINUTO, emMinuto(30)), null)
  portao.soltar()
  await cerca
  assert.equal((await store.claimOutbox('w2', UM_MINUTO, emMinuto(30)))?.outboxId, 'o1')
})

test('operação que falha solta a cerca e a trava da tarefa', async () => {
  const store = new SqliteTaskStore(await bancoMigrado(), 'maquina-teste')
  const { tarefa: t1, claim } = await emExecucao(store, 't1', 'o1')
  await assert.rejects(store.withExecutionFence(claim, 1, 'execute', async () => { throw new Error('efeito quebrou') }, DENTRO_DO_LEASE), /efeito quebrou/)
  assert.equal((await store.compareAndSwap(avancar(t1, 'failed'))).status, 'failed')
  assert.equal((await store.claimOutbox('w2', UM_MINUTO, emMinuto(30)))?.outboxId, 'o1')
})
