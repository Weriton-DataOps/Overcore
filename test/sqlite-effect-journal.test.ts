import assert from 'node:assert/strict'
import { test } from 'node:test'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { SqliteEffectJournalStore } from '../src/infrastructure/database/sqlite/sqlite-effect-journal-store.js'
import { minuto, reserva } from './support/fixtures-de-tarefa.js'
import { bancoMigrado } from './support/sqlite-fixtures.js'

// O comportamento da porta está no contrato (test/support/task-store-contract.ts); aqui fica só o que é do SQLite.

test('o efeito grava a origem, colide em UNIQUE pelo effectId e cada transição entra no diário', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteEffectJournalStore(arquivo, 'maquina-teste')
  await store.reserveEffect(reserva('e1'))
  await assert.rejects(store.reserveEffect(reserva('e2', 'id-e1')), /UNIQUE/)
  const gravado = comBanco(arquivo, (db) => db.prepare('SELECT count(*) AS n, max(origem_maquina) AS m FROM overcore_effect_journal').get())
  assert.deepEqual({ ...gravado }, { n: 1, m: 'maquina-teste' })
  await store.transitionEffect({ effectKey: 'e1', expectedRevision: 1, expectedStates: ['reserved'], nextState: 'applying', updatedAt: minuto(1), incrementApplyCount: true })
  await store.transitionEffect({ effectKey: 'e1', expectedRevision: 2, expectedStates: ['applying'], nextState: 'confirmed', updatedAt: minuto(2) })
  const diario = comBanco(arquivo, (db) => db.prepare("SELECT operacao, versao FROM _diario WHERE tabela = 'overcore_effect_journal' ORDER BY seq").all())
  assert.deepEqual(diario.map((linha) => [linha.operacao, linha.versao]), [['I', 1], ['U', 2], ['U', 3]])
})
