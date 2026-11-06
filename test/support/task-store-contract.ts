import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ClaimedMessage, JsonObject, StoredTask } from '../../src/domain/types.js'
import { ConcurrentEffectUpdateError, type EffectJournalStore } from '../../src/ports/effect-journal-store.js'
import { ExecutionInterruptedError } from '../../src/ports/execution-control.js'
import { ConcurrentPreflightUpdateError, DuplicatePreflightIntentError } from '../../src/ports/preflight-store.js'
import { ConcurrentTaskUpdateError, DuplicateTaskError, type TaskStore } from '../../src/ports/task-store.js'
import { avancar, emMinuto, evento, mensagem, minuto, recibo, reserva, revisao, sha, tarefa } from './fixtures-de-tarefa.js'

/**
 * Suíte única do contrato de TaskStore e EffectJournalStore (ADR-023, F4 C1).
 * Cada motor roda os mesmos testes e só é observado pela porta; o que é próprio de um motor
 * (diário, versão da linha, transação curta) fica nos testes dele.
 */
export interface BancoDeContrato {
  store: TaskStore
  journal: EffectJournalStore
  /** Outra instância sobre os mesmos dados, como depois de reiniciar o processo. */
  reabrir(): { store: TaskStore; journal: EffectJournalStore }
  contar(o_que: 'eventos' | 'outbox' | 'streams'): Promise<number>
}

export interface MotorDeContrato {
  nome: string
  /** Banco vazio e migrado, isolado dos outros testes. */
  abrir(): Promise<BancoDeContrato>
}

const UM_MINUTO = 60_000
const DENTRO_DO_LEASE = new Date(emMinuto(1).getTime() + 10_000)
const ids = (lista: StoredTask[]) => lista.map((t) => t.taskId)

function adiado(): { promessa: Promise<void>; soltar: () => void } {
  let soltar!: () => void
  const promessa = new Promise<void>((resolve) => { soltar = resolve })
  return { promessa, soltar }
}

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function comMensagens(store: TaskStore, mensagens: Array<[outboxId: string, disponivelNoMinuto: number]>): Promise<void> {
  for (const [outboxId, disponivel] of mensagens) {
    const taskId = `t-${outboxId}`
    const criada = await store.create(tarefa(taskId), evento(`ev-${taskId}`))
    await store.compareAndSwap(avancar(criada, 'running', { outbox: mensagem(outboxId, taskId, disponivel) }))
  }
}

/** Tarefa em execução com a mensagem dela reivindicada no minuto 1, lease de um minuto. */
async function emExecucao(store: TaskStore, taskId: string, outboxId: string): Promise<{ tarefa: StoredTask; claim: ClaimedMessage }> {
  const criada = await store.create(tarefa(taskId), evento(`ev-${taskId}`))
  const rodando = await store.compareAndSwap(avancar(criada, 'running', { outbox: mensagem(outboxId, taskId, 0) }))
  const claim = await store.claimOutbox('w1', UM_MINUTO, emMinuto(1))
  assert.equal(claim?.outboxId, outboxId)
  return { tarefa: rodando, claim }
}

export function contratoDoTaskStore(motor: MotorDeContrato): void {
  const caso = (nome: string, corpo: (banco: BancoDeContrato) => Promise<void>) =>
    test(`[${motor.nome}] ${nome}`, { timeout: 30_000 }, async () => corpo(await motor.abrir()))

  // Preflight (B2)

  caso('preflight: grava, relê pelas três chaves e devolve a mesma revisão no replay', async ({ store, reabrir }) => {
    const primeira = revisao('d1', 1)
    assert.deepEqual(await store.appendPreflightRevision(primeira, 0), primeira)
    assert.deepEqual(await store.appendPreflightRevision(primeira, 0), primeira)
    const reaberto = reabrir().store
    assert.deepEqual(await reaberto.findPreflightRevision('d1', 1), primeira)
    assert.deepEqual(await reaberto.findPreflightReport(primeira.reportId), primeira.report)
    assert.deepEqual(await reaberto.findLatestPreflightByIdempotencyKey('chave-d1'), primeira)
    assert.equal(await reaberto.findPreflightRevision('d1', 2), null)
    assert.equal(await reaberto.findPreflightReport('nao-existe'), null)
    assert.equal(await reaberto.findLatestPreflightByIdempotencyKey('nao-existe'), null)
  })

  caso('preflight: a segunda revisão vira a mais recente da chave', async ({ store }) => {
    await store.appendPreflightRevision(revisao('d1', 1), 0)
    const segunda = revisao('d1', 2)
    assert.deepEqual(await store.appendPreflightRevision(segunda, 1), segunda)
    assert.deepEqual(await store.findLatestPreflightByIdempotencyKey('chave-d1'), segunda)
  })

  caso('preflight: conteúdo diferente na mesma revisão e revisão anterior velha são concorrência', async ({ store }) => {
    await store.appendPreflightRevision(revisao('d1', 1), 0)
    await assert.rejects(store.appendPreflightRevision(revisao('d1', 1, { digito: 'c' }), 0), ConcurrentPreflightUpdateError)
    await assert.rejects(store.appendPreflightRevision(revisao('d1', 3), 2), ConcurrentPreflightUpdateError)
    await assert.rejects(store.appendPreflightRevision(revisao('d2', 2), 1), ConcurrentPreflightUpdateError)
    await assert.rejects(store.appendPreflightRevision(revisao('d1', 3), 1), /precisa avançar exatamente uma posição/)
  })

  caso('preflight: a chave idempotente pertence a um draft só', async ({ store }) => {
    await store.appendPreflightRevision(revisao('d1', 1), 0)
    const doD1 = (error: unknown) => error instanceof DuplicatePreflightIntentError && error.existingDraftId === 'd1'
    await assert.rejects(store.appendPreflightRevision(revisao('d2', 1, { chave: 'chave-d1' }), 0), doD1)
    await assert.rejects(store.appendPreflightRevision(revisao('d1', 2, { chave: 'outra' }), 1), doD1)
  })

  caso('preflight: relatório repetido em outro draft vira concorrência e não deixa stream órfão', async ({ store, contar }) => {
    await store.appendPreflightRevision(revisao('d1', 1), 0)
    await assert.rejects(store.appendPreflightRevision(revisao('d2', 1, { reportId: 'rep-d1-1' }), 0), ConcurrentPreflightUpdateError)
    assert.equal(await store.findLatestPreflightByIdempotencyKey('chave-d2'), null)
    assert.equal(await contar('streams'), 1)
  })

  // Admissão e CAS (B3)

  caso('tarefa: cria com o evento e relê pelas duas chaves depois de reabrir', async ({ store, reabrir }) => {
    const t1 = tarefa('t1')
    assert.deepEqual(await store.create(t1, evento('ev-t1-1')), t1)
    const reaberto = reabrir().store
    assert.deepEqual(await reaberto.findById('t1'), t1)
    assert.deepEqual(await reaberto.findByIdempotencyKey('chave-t1'), t1)
    assert.equal(await reaberto.findById('nao-existe'), null)
    assert.equal(await reaberto.findByIdempotencyKey('nao-existe'), null)
  })

  caso('tarefa: a lista sai da mais recente para a mais velha, desempata pelo id e filtra por estado', async ({ store }) => {
    await store.create(tarefa('t3'), evento('ev-t3-1'))
    await store.create(tarefa('t1'), evento('ev-t1-1'))
    const t2 = await store.create(tarefa('t2'), evento('ev-t2-1'))
    await store.compareAndSwap(avancar(t2, 'running', { outbox: mensagem('o2', 't2', 0) }))
    assert.deepEqual(ids(await store.listTasks({ limit: 10 })), ['t2', 't1', 't3'])
    assert.deepEqual(ids(await store.listTasks({ limit: 2 })), ['t2', 't1'])
    assert.deepEqual(ids(await store.listTasks({ limit: 10, statuses: ['accepted'] })), ['t1', 't3'])
    assert.deepEqual(ids(await store.listTasks({ limit: 10, statuses: ['running', 'accepted'] })), ['t2', 't1', 't3'])
    assert.deepEqual(ids(await store.listTasks({ limit: 10, statuses: [] })), ['t2', 't1', 't3'], 'lista vazia não filtra')
    assert.deepEqual(await store.listTasks({ limit: 10, statuses: ['succeeded'] }), [])
    assert.deepEqual(await store.listTasks({ limit: 0 }), [])
  })

  caso('tarefa: admissão repetida aponta a existente e não grava evento de novo', async ({ store, contar }) => {
    await store.create(tarefa('t1'), evento('ev-t1-1'))
    const duplicada = (error: unknown) => error instanceof DuplicateTaskError && error.existingTaskId === 't1'
    await assert.rejects(store.create(tarefa('t1'), evento('ev-t1-1b')), duplicada)
    await assert.rejects(store.create(tarefa('t2', { chave: 'chave-t1' }), evento('ev-t2-1')), duplicada)
    await assert.rejects(store.create(tarefa('t3', { requestId: 'req-t1' }), evento('ev-t3-1')),
      (error: unknown) => error instanceof Error && !(error instanceof DuplicateTaskError))
    assert.equal(await contar('eventos'), 1)
    assert.equal(await store.findById('t2'), null)
    assert.equal(await store.findById('t3'), null)
  })

  caso('tarefa: o CAS avança e grava plano, autorização, evento e outbox juntos', async ({ store, contar }) => {
    const t1 = await store.create(tarefa('t1'), evento('ev-t1-1'))
    const plano: JsonObject = { planId: 'p1', planRevision: 1, planFingerprint: { algorithm: 'sha256-jcs-v1', value: sha('a') }, createdAt: minuto(1) }
    const t2 = await store.compareAndSwap(avancar(t1, 'planning', { plan: plano }))
    assert.equal(t2.stateRevision, 2)
    assert.deepEqual(await store.findPlan('t1', 'p1', 1), plano)
    assert.equal(await store.findPlan('t1', 'p1', 2), null)

    const autorizacao = {
      request: { authorizationRequestId: 'ar1', planBinding: { planId: 'p1', planRevision: 1 } },
      decision: { decisionId: 'dec1', limits: { expiresAt: '2026-11-05T09:30:00-03:00' } },
      enforcement: { enforcementId: 'enf1' }
    }
    const t3 = await store.compareAndSwap(avancar(t2, 'running', { authorization: autorizacao, outbox: mensagem('o1', 't1', 2) }))
    assert.deepEqual(await store.findById('t1'), t3)
    assert.deepEqual(await store.findAuthorization('t1', 'dec1'), autorizacao)
    assert.equal(await store.findAuthorization('t1', 'outra'), null)
    assert.equal(await contar('eventos'), 3)
    assert.equal(await contar('outbox'), 1)
    assert.equal((await store.claimOutbox('w1', UM_MINUTO, emMinuto(2)))?.outboxId, 'o1')
  })

  caso('tarefa: CAS com revisão velha ou que pula revisão falha sem mexer na tarefa', async ({ store, contar }) => {
    const t1 = await store.create(tarefa('t1'), evento('ev-t1-1'))
    const t2 = await store.compareAndSwap(avancar(t1, 'planning'))
    await assert.rejects(store.compareAndSwap(avancar(t1, 'ready')), ConcurrentTaskUpdateError)
    await assert.rejects(store.compareAndSwap({ ...avancar(t2, 'ready'), expectedRevision: 1 }), /CAS precisa avançar exatamente uma revisão/)
    assert.deepEqual(await store.findById('t1'), t2)
    assert.equal(await contar('eventos'), 2)
  })

  caso('tarefa: falha no meio do CAS desfaz a tarefa, o evento e a outbox', async ({ store, contar }) => {
    const t1 = await store.create(tarefa('t1'), evento('ev-t1-1'))
    const t2 = await store.compareAndSwap(avancar(t1, 'planning', { outbox: mensagem('o1', 't1', 1) }))
    await assert.rejects(store.compareAndSwap(avancar(t2, 'ready', { outbox: mensagem('o1', 't1', 1) })))
    await assert.rejects(store.compareAndSwap(avancar(t2, 'ready', { completeOutbox: { outboxId: 'o1', claimToken: 'alheio' } })),
      /Lease da outbox não confere no fechamento transacional/)
    assert.deepEqual(await store.findById('t1'), t2)
    assert.equal(await contar('eventos'), 2)
    assert.equal(await contar('outbox'), 1)
  })

  // Outbox e reconciliação (B4)

  caso('outbox: reivindica pela ordem de disponibilidade e ignora o que ainda não venceu', async ({ store }) => {
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

  caso('outbox: lease vencido é reivindicado de novo e o token velho perde o direito', async ({ store }) => {
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

  caso('outbox: renovar estende o lease; soltar com token errado falha e soltar certo respeita o retryAt', async ({ store }) => {
    await comMensagens(store, [['o1', 0]])
    const claim = await store.claimOutbox('w1', UM_MINUTO, emMinuto(1))
    assert.ok(claim)
    await store.extendOutboxLease('o1', claim.claimToken, UM_MINUTO, new Date(emMinuto(1).getTime() + 30_000))
    assert.equal(await store.claimOutbox('w2', UM_MINUTO, emMinuto(2)), null)
    await assert.rejects(store.extendOutboxLease('o1', claim.claimToken, UM_MINUTO, emMinuto(3)), /Lease da outbox nao pode ser renovado/)
    await assert.rejects(store.releaseOutbox('o1', 'alheio', 'fp', emMinuto(10)), /Lease da outbox não confere/)
    await store.releaseOutbox('o1', claim.claimToken, 'fp-erro', emMinuto(10))
    assert.equal(await store.claimOutbox('w2', UM_MINUTO, emMinuto(9)), null)
    assert.equal((await store.claimOutbox('w2', UM_MINUTO, emMinuto(10)))?.attempts, 2)
  })

  caso('reconciliação: candidatos em ordem, posse exclusiva, adiamento com retry e soltura', async ({ store }) => {
    for (const id of ['t3', 't1', 't2']) await store.create(tarefa(id), evento(`ev-${id}`))
    await store.create(tarefa('t4', { status: 'running' }), evento('ev-t4'))
    await store.create(tarefa('t5', { status: 'cancelling' }), evento('ev-t5'))
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
    const doT2 = await store.claimReconciliation('t2', 'r1', UM_MINUTO, emMinuto(1))
    assert.ok(t2 && doT2)
    await store.deferReconciliation('t2', doT2, falha)
    const rodando = await store.compareAndSwap(avancar(t2, 'running'))
    assert.equal(rodando.reconciliation, undefined)
    assert.equal((await store.findById('t2'))?.reconciliation, undefined)
  })

  // Cerca de execução (B5)

  caso('cerca: época, estado, token, lease vencido ou mensagem fechada interrompem sem rodar a operação', async ({ store }) => {
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
    assert.equal(await store.withExecutionFence(claim, 1, 'execute', async () => 'valor', DENTRO_DO_LEASE), 'valor')

    const cancelando = await store.compareAndSwap(avancar(rodando, 'cancelling'))
    await assert.rejects(store.withExecutionFence(claim, 1, 'execute', operacao, DENTRO_DO_LEASE), ExecutionInterruptedError)
    await store.withExecutionFence(claim, cancelando.executionEpoch, 'reconcile', operacao, DENTRO_DO_LEASE)
    assert.equal(rodou, 1)
    await store.completeOutbox('o1', claim.claimToken)
    await assert.rejects(store.withExecutionFence(claim, 1, 'reconcile', operacao, DENTRO_DO_LEASE), ExecutionInterruptedError)
    assert.equal(rodou, 1)
  })

  caso('cerca: o CAS da mesma tarefa espera o fim do efeito; o de outra tarefa passa', async ({ store }) => {
    const { tarefa: t1, claim } = await emExecucao(store, 't1', 'o1')
    const u1 = await store.create(tarefa('u1'), evento('ev-u1'))
    const ordem: string[] = []
    const portao = adiado()
    const cerca = store.withExecutionFence(claim, 1, 'execute', async () => {
      await portao.promessa
      ordem.push('operação')
      return 'feito'
    }, DENTRO_DO_LEASE)
    await esperar(50)
    const cas = store.compareAndSwap(avancar(t1, 'cancelling')).then((tarefaNova) => { ordem.push('cas'); return tarefaNova })
    await store.compareAndSwap(avancar(u1, 'planning'))
    await esperar(100)
    assert.deepEqual(ordem, [])
    portao.soltar()
    assert.equal(await cerca, 'feito')
    assert.equal((await cas).status, 'cancelling')
    assert.deepEqual(ordem, ['operação', 'cas'])
  })

  caso('cerca: claimOutbox pula a mensagem em cerca, mesmo com o lease vencido, e volta a pegar depois', async ({ store }) => {
    const { claim } = await emExecucao(store, 't1', 'o1')
    const outra = await store.create(tarefa('t2'), evento('ev-t2'))
    await store.compareAndSwap(avancar(outra, 'running', { outbox: mensagem('o2', 't2', 0) }))
    const portao = adiado()
    const cerca = store.withExecutionFence(claim, 1, 'execute', () => portao.promessa, DENTRO_DO_LEASE)
    await esperar(50)
    const durante = await Promise.race([
      (async () => [
        (await store.claimOutbox('w2', UM_MINUTO, emMinuto(30)))?.outboxId ?? null,
        (await store.claimOutbox('w2', UM_MINUTO, emMinuto(30)))?.outboxId ?? null
      ])(),
      esperar(2_000).then(() => 'claimOutbox esperou a cerca em vez de pular a mensagem')
    ])
    portao.soltar()
    await cerca
    assert.deepEqual(durante, ['o2', null])
    assert.equal((await store.claimOutbox('w2', UM_MINUTO, emMinuto(30)))?.outboxId, 'o1')
  })

  caso('cerca: operação que falha solta a cerca e a trava da tarefa', async ({ store }) => {
    const { tarefa: t1, claim } = await emExecucao(store, 't1', 'o1')
    await assert.rejects(store.withExecutionFence(claim, 1, 'execute', async () => { throw new Error('efeito quebrou') }, DENTRO_DO_LEASE), /efeito quebrou/)
    assert.equal((await store.compareAndSwap(avancar(t1, 'failed'))).status, 'failed')
    assert.equal((await store.claimOutbox('w2', UM_MINUTO, emMinuto(30)))?.outboxId, 'o1')
  })

  // Diário de efeitos (B6)

  caso('efeito: reserva é idempotente pela chave e sobrevive à reabertura', async ({ journal, reabrir }) => {
    const original = reserva('e1')
    assert.deepEqual(await journal.reserveEffect(original), original)
    assert.deepEqual(await journal.reserveEffect({ ...original, checkpointRef: 'outro' }), original)
    assert.deepEqual(await reabrir().journal.findEffect('e1'), original)
    assert.equal(await journal.findEffect('nao-existe'), null)
    await assert.rejects(journal.reserveEffect(reserva('e2', 'id-e1')))
    assert.equal(await journal.findEffect('e2'), null)
  })

  caso('efeito: transição permitida avança revisão, contagem e campos de confirmação', async ({ journal }) => {
    await journal.reserveEffect(reserva('e1'))
    const aplicando = await journal.transitionEffect({
      effectKey: 'e1', expectedRevision: 1, expectedStates: ['reserved'], nextState: 'applying',
      updatedAt: '2026-11-05T09:01:00-03:00', incrementApplyCount: true
    })
    assert.deepEqual({ state: aplicando.state, revision: aplicando.revision, applyCount: aplicando.applyCount, updatedAt: aplicando.updatedAt },
      { state: 'applying', revision: 2, applyCount: 1, updatedAt: minuto(1) })
    assert.equal('confirmedAt' in aplicando, false)
    const confirmado = await journal.transitionEffect({
      effectKey: 'e1', expectedRevision: 2, expectedStates: ['applying', 'unknown'], nextState: 'confirmed',
      updatedAt: minuto(2), confirmedAt: minuto(2), lastObservedDigest: sha('3')
    })
    assert.deepEqual(
      { state: confirmado.state, revision: confirmado.revision, applyCount: confirmado.applyCount, confirmedAt: confirmado.confirmedAt, lastObservedDigest: confirmado.lastObservedDigest },
      { state: 'confirmed', revision: 3, applyCount: 1, confirmedAt: minuto(2), lastObservedDigest: sha('3') })
    const mantido = await journal.transitionEffect({
      effectKey: 'e1', expectedRevision: 3, expectedStates: ['confirmed'], nextState: 'rolled-back', updatedAt: minuto(3), lastErrorFingerprint: sha('e')
    })
    assert.deepEqual({ observado: mantido.lastObservedDigest, confirmado: mantido.confirmedAt, erro: mantido.lastErrorFingerprint },
      { observado: sha('3'), confirmado: minuto(2), erro: sha('e') })
  })

  caso('efeito: revisão velha, estado fora do esperado ou efeito inexistente são concorrência e não mudam nada', async ({ journal }) => {
    const original = await journal.reserveEffect(reserva('e1'))
    const concorrencia = (error: unknown) => error instanceof ConcurrentEffectUpdateError && error.effectKey === 'e1' && error.expectedRevision === 1
    await assert.rejects(journal.transitionEffect({ effectKey: 'e1', expectedRevision: 1, expectedStates: ['applying'], nextState: 'confirmed', updatedAt: minuto(1) }), concorrencia)
    await journal.transitionEffect({ effectKey: 'e1', expectedRevision: 1, expectedStates: ['reserved'], nextState: 'not-applied', updatedAt: minuto(1) })
    await assert.rejects(journal.transitionEffect({ effectKey: 'e1', expectedRevision: 1, expectedStates: ['reserved', 'not-applied'], nextState: 'applying', updatedAt: minuto(2) }), concorrencia)
    await assert.rejects(journal.transitionEffect({ effectKey: 'e9', expectedRevision: 1, expectedStates: ['reserved'], nextState: 'applying', updatedAt: minuto(2) }), ConcurrentEffectUpdateError)
    assert.deepEqual(await journal.findEffect('e1'), { ...original, state: 'not-applied', revision: 2, updatedAt: minuto(1) })
  })

  // Recibos de execução (B7)

  caso('recibo: grava sob lease válido e o replay devolve o mesmo, também depois de reabrir', async ({ store, reabrir }) => {
    const { claim } = await emExecucao(store, 't1', 'o1')
    assert.equal(await store.findExecutionReceipt('o1'), null)
    assert.deepEqual(await store.saveExecutionReceipt(recibo('a', '2026-11-05T09:01:00-03:00'), claim.claimToken, DENTRO_DO_LEASE), recibo())
    assert.deepEqual(await store.saveExecutionReceipt(recibo(), claim.claimToken, DENTRO_DO_LEASE), recibo())
    assert.deepEqual(await store.saveExecutionReceipt({ ...recibo(), receiptId: 'rec-outro' }, claim.claimToken, DENTRO_DO_LEASE), recibo())
    assert.deepEqual(await reabrir().store.findExecutionReceipt('o1'), recibo())
  })

  caso('recibo: conteúdo diferente para a mesma outbox é recusado', async ({ store }) => {
    const { claim } = await emExecucao(store, 't1', 'o1')
    await store.saveExecutionReceipt(recibo('a'), claim.claimToken, DENTRO_DO_LEASE)
    await assert.rejects(store.saveExecutionReceipt(recibo('b'), claim.claimToken, DENTRO_DO_LEASE), /Recibo da outbox o1 possui outro conteudo/)
    assert.deepEqual(await store.findExecutionReceipt('o1'), recibo('a'))
  })

  caso('recibo: token errado, lease vencido ou mensagem fechada não gravam', async ({ store }) => {
    const { claim } = await emExecucao(store, 't1', 'o1')
    const recusa = /Lease da outbox nao permite persistir o recibo de execucao/
    await assert.rejects(store.saveExecutionReceipt(recibo(), 'alheio', DENTRO_DO_LEASE), recusa)
    await assert.rejects(store.saveExecutionReceipt(recibo(), claim.claimToken, emMinuto(5)), recusa)
    await store.completeOutbox('o1', claim.claimToken)
    await assert.rejects(store.saveExecutionReceipt(recibo(), claim.claimToken, DENTRO_DO_LEASE), recusa)
    assert.equal(await store.findExecutionReceipt('o1'), null)
  })
}
