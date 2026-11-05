import assert from 'node:assert/strict'
import { test } from 'node:test'
import { comBanco, transacao } from '../src/infrastructure/database/sqlite/banco.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import { avancar, bancoMigrado, emMinuto, evento, mensagem, tarefa } from './support/sqlite-fixtures.js'

// O comportamento da cerca está no contrato (test/support/task-store-contract.ts); aqui fica a D4 da ADR-023,
// que só existe no SQLite: nenhuma transação atravessa a operação.

const UM_MINUTO = 60_000
const DENTRO_DO_LEASE = new Date(emMinuto(1).getTime() + 10_000)

test('a operação roda sem transação aberta e devolve o valor dela', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const criada = await store.create(tarefa('t1'), evento('ev-t1'))
  await store.compareAndSwap(avancar(criada, 'running', { outbox: mensagem('o1', 't1', 0) }))
  const claim = await store.claimOutbox('w1', UM_MINUTO, emMinuto(1))
  assert.ok(claim)
  const valor = await store.withExecutionFence(claim, 1, 'execute', async () => {
    const inicio = Date.now()
    comBanco(arquivo, (db) => transacao(db, () => db.prepare("UPDATE overcore_tasks SET scope_key = 'outro' WHERE task_id = 'nada'").run()))
    await store.extendOutboxLease('o1', claim.claimToken, UM_MINUTO, DENTRO_DO_LEASE)
    return Date.now() - inicio
  }, DENTRO_DO_LEASE)
  assert.ok(valor < 1_000, `a escrita paralela esperou ${valor} ms: a cerca está segurando transação`)
})
