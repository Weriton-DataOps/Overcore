import assert from 'node:assert/strict'
import { test } from 'node:test'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { SqliteEffectJournalStore } from '../src/infrastructure/database/sqlite/sqlite-effect-journal-store.js'
import { ConcurrentEffectUpdateError, type EffectJournalRecord } from '../src/ports/effect-journal-store.js'
import { bancoMigrado, minuto } from './support/sqlite-fixtures.js'

const sha = (digito: string) => `sha256:${digito.repeat(64)}` as `sha256:${string}`

function reserva(effectKey: string, effectId = `id-${effectKey}`): EffectJournalRecord {
  return {
    effectId, effectKey, taskId: 't1', resourceRef: 'arquivo:a', targetUri: 'file:///tmp/a', operation: 'filesystem.modify',
    intentFingerprint: { algorithm: 'sha256-jcs-v1', value: sha('1') },
    beforeDigest: sha('2'), afterDigest: sha('3'),
    checkpointRef: 'cp1', checkpointUri: 'file:///tmp/cp1', checkpointDigest: sha('4'),
    state: 'reserved', revision: 1, applyCount: 0, reservedAt: minuto(0), updatedAt: minuto(0)
  }
}

test('reserva é idempotente pela chave do efeito e sobrevive à reabertura', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteEffectJournalStore(arquivo, 'maquina-teste')
  const original = reserva('e1')
  assert.deepEqual(await store.reserveEffect(original), original)
  assert.deepEqual(await store.reserveEffect({ ...original, checkpointRef: 'outro' }), original)
  assert.deepEqual(await new SqliteEffectJournalStore(arquivo, 'maquina-teste').findEffect('e1'), original)
  assert.equal(await store.findEffect('nao-existe'), null)
  await assert.rejects(store.reserveEffect(reserva('e2', 'id-e1')), /UNIQUE/)
  const gravado = comBanco(arquivo, (db) => db.prepare('SELECT count(*) AS n, max(origem_maquina) AS m FROM overcore_effect_journal').get())
  assert.deepEqual({ ...gravado }, { n: 1, m: 'maquina-teste' })
})

test('transição permitida avança revisão, contagem e campos de confirmação', async () => {
  const arquivo = await bancoMigrado()
  const store = new SqliteEffectJournalStore(arquivo, 'maquina-teste')
  await store.reserveEffect(reserva('e1'))
  const aplicando = await store.transitionEffect({
    effectKey: 'e1', expectedRevision: 1, expectedStates: ['reserved'], nextState: 'applying',
    updatedAt: '2026-11-05T09:01:00-03:00', incrementApplyCount: true
  })
  assert.equal(aplicando.state, 'applying')
  assert.equal(aplicando.revision, 2)
  assert.equal(aplicando.applyCount, 1)
  assert.equal(aplicando.updatedAt, minuto(1))
  assert.equal('confirmedAt' in aplicando, false)
  const confirmado = await store.transitionEffect({
    effectKey: 'e1', expectedRevision: 2, expectedStates: ['applying', 'unknown'], nextState: 'confirmed',
    updatedAt: minuto(2), confirmedAt: minuto(2), lastObservedDigest: sha('3')
  })
  assert.deepEqual(
    { state: confirmado.state, revision: confirmado.revision, applyCount: confirmado.applyCount, confirmedAt: confirmado.confirmedAt, lastObservedDigest: confirmado.lastObservedDigest },
    { state: 'confirmed', revision: 3, applyCount: 1, confirmedAt: minuto(2), lastObservedDigest: sha('3') })
  const mantido = await store.transitionEffect({
    effectKey: 'e1', expectedRevision: 3, expectedStates: ['confirmed'], nextState: 'rolled-back', updatedAt: minuto(3), lastErrorFingerprint: sha('e')
  })
  assert.equal(mantido.lastObservedDigest, sha('3'))
  assert.equal(mantido.confirmedAt, minuto(2))
  assert.equal(mantido.lastErrorFingerprint, sha('e'))
  const diario = comBanco(arquivo, (db) => db.prepare("SELECT operacao, versao FROM _diario WHERE tabela = 'overcore_effect_journal' ORDER BY seq").all())
  assert.deepEqual(diario.map((linha) => [linha.operacao, linha.versao]), [['I', 1], ['U', 2], ['U', 3], ['U', 4]])
})

test('revisão velha, estado fora do esperado ou efeito inexistente são concorrência e não mudam nada', async () => {
  const store = new SqliteEffectJournalStore(await bancoMigrado(), 'maquina-teste')
  const original = await store.reserveEffect(reserva('e1'))
  const concorrencia = (error: unknown) => error instanceof ConcurrentEffectUpdateError && error.effectKey === 'e1' && error.expectedRevision === 1
  await assert.rejects(store.transitionEffect({ effectKey: 'e1', expectedRevision: 1, expectedStates: ['applying'], nextState: 'confirmed', updatedAt: minuto(1) }), concorrencia)
  await store.transitionEffect({ effectKey: 'e1', expectedRevision: 1, expectedStates: ['reserved'], nextState: 'not-applied', updatedAt: minuto(1) })
  await assert.rejects(store.transitionEffect({ effectKey: 'e1', expectedRevision: 1, expectedStates: ['reserved', 'not-applied'], nextState: 'applying', updatedAt: minuto(2) }), concorrencia)
  await assert.rejects(store.transitionEffect({ effectKey: 'e9', expectedRevision: 1, expectedStates: ['reserved'], nextState: 'applying', updatedAt: minuto(2) }), ConcurrentEffectUpdateError)
  const atual = await store.findEffect('e1')
  assert.deepEqual(atual, { ...original, state: 'not-applied', revision: 2, updatedAt: minuto(1) })
})
