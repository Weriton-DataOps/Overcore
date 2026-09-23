import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { AgentAssistedContractInspectionExecutor, ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { HarnessFileReplacementExecutor } from '../src/application/file-replacement-executor.js'
import { FileEffectHarness, type FileEffectHarnessHooks } from '../src/application/file-effect-harness.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { sha256 } from '../src/domain/fingerprint.js'
import type { CasMutation, JsonObject, StoredTask, TaskRequest } from '../src/domain/types.js'
import { FileCheckpointStore } from '../src/infrastructure/checkpoints/file-checkpoint-store.js'
import { createLocalServer } from '../src/infrastructure/http/local-server.js'
import type { EffectAuthorityGuard } from '../src/ports/effect-journal-store.js'
import { InMemoryEffectJournalStore } from '../src/testing/in-memory-effect-journal-store.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()
const validatorPromise = ContractValidator.create(root)
function latch() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
class Clock { private time = Date.now(); now() { return new Date(this.time) }; advance(ms: number) { this.time += ms } }
class FailOnceStore extends InMemoryTaskStore {
  failed = false
  constructor(private kind: string) { super() }
  override async compareAndSwap(mutation: CasMutation) {
    if (!this.failed && mutation.event.kind === this.kind) { this.failed = true; throw new Error('queda simulada') }
    return super.compareAndSwap(mutation)
  }
}
async function fixture(name: string): Promise<TaskRequest> {
  const request = JSON.parse(await readFile(join(root, 'contratos/exemplos/task-request-inspecao-executavel.json'), 'utf8')) as TaskRequest
  request.requestId = `request-cancellation-${name}`
  request.idempotencyKey = `cancellation-${name}`
  request.context.references[0]!.uri = pathToFileURL(root).href
  return request
}
function assertClosed(task: StoredTask | null, validator: ContractValidator) {
  assert.ok(task)
  assert.equal(task.status, 'cancelled')
  validator.taskState(task.state)
  validator.assert('task-result', task.result)
  assert.equal((task.result!.stateRef as JsonObject).stateRevision, task.stateRevision)
  assert.equal((task.result!.stateRef as JsonObject).transitionId, task.state.lifecycle.lastTransitionId)
  assert.equal(task.state.activeAttemptId, undefined)
}

test('cancelamento repetido de tarefa na fila não chama executor nem cria retry', async () => {
  const validator: ContractValidator = await validatorPromise
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const task = await manager.submit(await fixture('queued'))
  const answers = await Promise.all([manager.cancel(task.taskId), manager.cancel(task.taskId)])
  assert.ok(answers.every((answer) => answer?.status === 'cancelling'))
  const worker = new TaskWorker('worker-cancel-queued', store, validator, { execute: async () => { throw new Error('Não deve executar') } })
  const result = await worker.runOnce()
  assertClosed(result, validator)
  assert.equal(result?.executionEpoch, task.executionEpoch + 1)
  assert.equal(store.outbox.size, 0)
  assert.deepEqual(await manager.cancel(task.taskId), result)
  assert.equal(await worker.runOnce(), null)
  assert.equal(store.events.filter((item) => item.kind === 'cancellation-requested').length, 1)
})

test('API cancela inspeção ativa e o AbortSignal chega ao adaptador do SDK', { timeout: 6000 }, async () => {
  const validator: ContractValidator = await validatorPromise
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const task = await manager.submit(await fixture('active-sdk'))
  const started = latch()
  let receivedSignal: AbortSignal | undefined
  const executor = new AgentAssistedContractInspectionExecutor({ run: async (_input, _events, signal) => {
    receivedSignal = signal
    started.resolve()
    return new Promise((_resolve, reject) => {
      assert.ok(signal)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  } })
  const worker = new TaskWorker('worker-active-sdk', store, validator, executor)
  const server = createLocalServer(manager, worker, 'token-cancellation-http-test')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const execution = worker.runOnce()
    await started.promise
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/v1/tasks/${task.taskId}/cancel`
    assert.equal((await fetch(url, { method: 'POST' })).status, 401)
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer token-cancellation-http-test' } })
    assert.equal(response.status, 202)
    assert.equal((await response.json() as StoredTask).status, 'cancelling')
    assertClosed(await execution, validator)
    assert.equal(receivedSignal?.aborted, true)
    assert.equal(store.outbox.size, 0)
    assert.equal(store.events.some((event) => event.kind === 'retry-scheduled'), false)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('queda após quiescência termina cancelamento sem duplicar a transição', async () => {
  const validator: ContractValidator = await validatorPromise
  const store = new FailOnceStore('task-cancelled')
  const clock = new Clock()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider(() => clock.now()), clock)
  const task = await manager.submit(await fixture('resume-quiesced'))
  await manager.cancel(task.taskId)
  const worker = new TaskWorker('worker-cancel-crash', store, validator, new ReadOnlyContractInspectionExecutor(), clock)
  // The same delivery may recover the interrupted terminal CAS immediately.
  const completed = await worker.runOnce()
  assertClosed(completed, validator)
  assert.equal(store.events.filter((event) => event.kind === 'cancellation-quiesced').length, 1)
  assert.equal(store.outbox.size, 0)
})

test('resultado tardio do executor não vence cancelamento já persistido', async () => {
  const validator: ContractValidator = await validatorPromise
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const task = await manager.submit(await fixture('late-success'))
  const started = latch(); const release = latch()
  const worker = new TaskWorker('worker-late-success', store, validator, { execute: async (input) => {
    const result = await new ReadOnlyContractInspectionExecutor().execute(input)
    started.resolve(); await release.promise
    return result
  } })
  const running = worker.runOnce()
  await started.promise
  await manager.cancel(task.taskId)
  assert.equal((await store.findById(task.taskId))?.status, 'cancelling')
  release.resolve()
  assertClosed(await running, validator)
  assert.equal(store.events.some((event) => event.kind === 'task-succeeded'), false)
  assert.equal(store.outbox.size, 0)
})

test('sucesso já persistido não é reaberto por cancelamento atrasado', async () => {
  const validator: ContractValidator = await validatorPromise
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const task = await manager.submit(await fixture('completed-first'))
  const completed = await new TaskWorker('worker-completed-first', store, validator, new ReadOnlyContractInspectionExecutor()).runOnce()
  assert.equal(completed?.status, 'succeeded')
  assert.deepEqual(await manager.cancel(task.taskId), completed)
})

test('cancelamento antes do dispatch se recupera de queda entre as gravações', async () => {
  const validator: ContractValidator = await validatorPromise
  const store = new FailOnceStore('planning-started')
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const task = await manager.submit(await fixture('before-dispatch-crash'))
  const original = store.compareAndSwap.bind(store)
  let interrupted = false
  store.compareAndSwap = async (mutation) => {
    if (!interrupted && mutation.event.kind === 'cancellation-quiesced') { interrupted = true; throw new Error('queda simulada') }
    return original(mutation)
  }
  await assert.rejects(manager.cancel(task.taskId), /queda simulada/)
  await new TaskManager(store, validator, new PermittingAuthorityProvider()).reconcilePending()
  assertClosed(await store.findById(task.taskId), validator)
})

async function fileScenario(name: string, store = new InMemoryTaskStore(), hooks: FileEffectHarnessHooks = {}, guard?: EffectAuthorityGuard) {
  const validator: ContractValidator = await validatorPromise
  const directory = await mkdtemp(join(tmpdir(), 'overcore-cancel-file-'))
  const target = join(directory, 'target.txt')
  await writeFile(target, 'before')
  const request = await fixture(name)
  const resourceRef = request.context.references[0]!.refId
  request.context.references[0]!.uri = pathToFileURL(target).href
  request.context.references[0]!.kind = 'file'
  request.objective = 'Substituir um arquivo descartável e testar seu cancelamento.'
  request.context.summary = 'Teste isolado de cancelamento.'
  request.constraints = []
  request.authority.grants[0]!.operations = ['filesystem.read', 'filesystem.modify']
  request.acceptanceCriteria = [{ id: 'criterion-cancel-file-readback', description: 'Conteúdo esperado no arquivo.', verification: { method: 'inspection', expected: 'after' } }]
  request.expectedOutput = { kind: 'file', mediaType: 'text/plain', destinationRef: resourceRef }
  request.execution = { kind: 'replace-file-content', resourceRef, desiredContent: 'after', expectedBeforeDigest: sha256('before') }
  const clock = new Clock()
  const journal = new InMemoryEffectJournalStore()
  const executor = new HarnessFileReplacementExecutor(new FileEffectHarness(journal, new FileCheckpointStore(join(directory, 'checkpoints')),
    guard ?? { assertActive: async () => ({ checkedAt: clock.now().toISOString(), evidenceId: 'evidence-cancel-authority', digest: sha256('active') }) }, () => clock.now(), hooks))
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider(() => clock.now()), clock)
  const task = await manager.submit(request)
  const worker = new TaskWorker(`worker-cancel-${name}`, store, validator, new ReadOnlyContractInspectionExecutor(), clock, executor)
  return { directory, target, store, journal, manager, task, worker, clock, validator }
}

test('cancelamento durante revalidação de autoridade impede escrita e classifica not-applied', async () => {
  const entered = latch(); const release = latch()
  const scenario = await fileScenario('authority-wait', undefined, {}, { assertActive: async () => {
    entered.resolve(); await release.promise
    return { checkedAt: new Date().toISOString(), evidenceId: 'evidence-authority-wait', digest: sha256('active') }
  } })
  try {
    const execution = scenario.worker.runOnce()
    await entered.promise
    assert.equal((await scenario.manager.cancel(scenario.task.taskId))?.status, 'cancelling')
    release.resolve()
    const completed = await execution
    assertClosed(completed, scenario.validator)
    assert.equal(await readFile(scenario.target, 'utf8'), 'before')
    assert.equal((completed!.result!.effects as JsonObject[])[0]?.status, 'not-applied')
    assert.equal([...scenario.journal.records.values()][0]?.applyCount, 0)
  } finally { release.resolve(); await rm(scenario.directory, { recursive: true, force: true }) }
})

for (const point of ['afterMarkedApplying', 'afterAtomicWrite'] as const) {
  test(`queda ${point}: cancelar reconcilia o arquivo sem repetir o efeito`, async () => {
    const scenario = await fileScenario(point, undefined, { [point]: () => { throw new Error('queda simulada') } })
    try {
      await scenario.worker.runOnce()
      await scenario.manager.cancel(scenario.task.taskId)
      scenario.clock.advance(5_001)
      const completed = await scenario.worker.runOnce()
      assertClosed(completed, scenario.validator)
      const expected = point === 'afterAtomicWrite' ? 'confirmed' : 'not-applied'
      assert.equal((completed!.result!.effects as JsonObject[])[0]?.status, expected)
      assert.equal(await readFile(scenario.target, 'utf8'), expected === 'confirmed' ? 'after' : 'before')
      assert.equal([...scenario.journal.records.values()][0]?.applyCount, 1)
      assert.equal(scenario.store.outbox.size, 0)
    } finally { await rm(scenario.directory, { recursive: true, force: true }) }
  })
}

test('cancelar em verifying preserva efeito confirmado e checkpoint no resultado', async () => {
  const scenario = await fileScenario('verifying', new FailOnceStore('task-succeeded'))
  try {
    await assert.rejects(scenario.worker.runOnce(), /queda simulada/)
    assert.equal((await scenario.store.findById(scenario.task.taskId))?.status, 'verifying')
    await scenario.manager.cancel(scenario.task.taskId)
    scenario.clock.advance(5_001)
    const completed = await scenario.worker.runOnce()
    assertClosed(completed, scenario.validator)
    assert.equal((completed!.result!.effects as JsonObject[])[0]?.status, 'confirmed')
    assert.equal((completed!.result!.artifacts as JsonObject[])[0]?.kind, 'checkpoint')
    assert.equal(await readFile(scenario.target, 'utf8'), 'after')
  } finally { await rm(scenario.directory, { recursive: true, force: true }) }
})

test('conteúdo divergente durante recuperação permanece unknown e não é sobrescrito', async () => {
  const scenario = await fileScenario('unknown', undefined, { afterMarkedApplying: () => { throw new Error('queda simulada') } })
  try {
    await scenario.worker.runOnce()
    await writeFile(scenario.target, 'external-change')
    await scenario.manager.cancel(scenario.task.taskId)
    scenario.clock.advance(5_001)
    const completed = await scenario.worker.runOnce()
    assertClosed(completed, scenario.validator)
    assert.equal((completed!.result!.effects as JsonObject[])[0]?.status, 'unknown')
    assert.equal(await readFile(scenario.target, 'utf8'), 'external-change')
  } finally { await rm(scenario.directory, { recursive: true, force: true }) }
})

test('fence rejeita executor antigo após troca de epoch ou perda de lease', async () => {
  const validator: ContractValidator = await validatorPromise
  const store = new InMemoryTaskStore()
  const clock = new Clock()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider(() => clock.now()), clock)
  const task = await manager.submit(await fixture('stale-worker'))
  const claim = await store.claimOutbox('worker-obsolete', 1000, clock.now())
  assert.ok(claim)
  let mutations = 0
  await manager.cancel(task.taskId)
  await assert.rejects(store.withExecutionFence(claim, task.executionEpoch, 'execute', async () => { mutations += 1 }, clock.now()), /interrompida/)
  clock.advance(1001)
  const replacement = await store.claimOutbox('worker-replacement', 30_000, clock.now())
  assert.ok(replacement)
  await assert.rejects(store.withExecutionFence(claim, task.executionEpoch + 1, 'reconcile', async () => { mutations += 1 }, clock.now()), /interrompida/)
  assert.equal(mutations, 0)
})
