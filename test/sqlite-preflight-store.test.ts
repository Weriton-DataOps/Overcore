import assert from 'node:assert/strict'
import { test } from 'node:test'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { SqlitePreflightStore } from '../src/infrastructure/database/sqlite/sqlite-preflight-store.js'
import { revisao } from './support/fixtures-de-tarefa.js'
import { bancoMigrado } from './support/sqlite-fixtures.js'

// O comportamento da porta está no contrato (test/support/task-store-contract.ts); aqui fica só o que é do SQLite.

test('o stream avança com a versão da linha, a origem da máquina e o diário', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqlitePreflightStore(arquivo, 'maquina-teste')
  await store.appendPreflightRevision(revisao('d1', 1), 0)
  await store.appendPreflightRevision(revisao('d1', 2), 1)
  const stream = comBanco(arquivo, (db) => db.prepare('SELECT latest_revision, status, versao, origem_maquina FROM overcore_preflight_streams').get())
  assert.deepEqual({ ...stream }, { latest_revision: 2, status: 'ready', versao: 2, origem_maquina: 'maquina-teste' })
  const diario = comBanco(arquivo, (db) => db.prepare("SELECT operacao, versao FROM _diario WHERE tabela = 'overcore_preflight_streams' ORDER BY seq").all())
  assert.deepEqual(diario.map((linha) => [linha.operacao, linha.versao]), [['I', 1], ['U', 2]])
})
