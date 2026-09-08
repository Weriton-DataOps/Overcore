import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { TaskManager, type Clock } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { fingerprint } from '../src/domain/fingerprint.js'
import type { CasMutation, JsonObject, TaskRequest } from '../src/domain/types.js'
import { ExecutionFailure, type InspectionExecutor } from '../src/ports/task-store.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()

class MutableClock implements Clock {
  constructor(private current = new Date()) {}

  now(): Date {
    return new Date(this.current)
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds)
  }
}

class FailOnceTaskStore extends InMemoryTaskStore {
  private failed = false

  constructor(private readonly eventKind: string) {
    super()
  }

  override async compareAndSwap(mutation: CasMutation) {
    if (!this.failed && mutation.event.kind === this.eventKind) {
      this.failed = true
      throw new Error(`queda simulada em ${this.eventKind}`)
    }
    return super.compareAndSwap(mutation)
  }
}

class CountingExecutor implements InspectionExecutor {
  calls = 0

  constructor(
    private readonly transientFailures: number,
    private readonly delegate = new ReadOnlyContractInspectionExecutor()
  ) {}

  async execute(input: Parameters<InspectionExecutor['execute']>[0]): Promise<JsonObject> {
    this.calls += 1
    if (this.calls <= this.transientFailures) {
      throw new ExecutionFailure(
        'agent-runtime-transient',
        'transient',
        true,
        `falha transitoria simulada ${this.calls}`,
        1_000
      )
    }
    return this.delegate.execute(input)
  }
}

async function requestFixture(suffix: string): Promise<TaskRequest> {
  const request = JSON.parse(
    await readFile(join(root, 'contratos', 'exemplos', 'task-request-inspecao-executavel.json'), 'utf8')
  ) as TaskRequest
  request.requestId = `req-execution-recovery-${suffix}`
  request.idempotencyKey = `execution-recovery-${suffix}`
  request.context.references[0]!.uri = pathToFileURL(root).href
  return request
}

test('recibo duravel conclui verificacao reentregue sem executar novamente', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new FailOnceTaskStore('task-succeeded')
  const clock = new MutableClock()
  const executor = new CountingExecutor(0)
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider(() => clock.now()), clock)
  const task = await manager.submit(await requestFixture('receipt-0001'))
  const worker = new TaskWorker('worker-receipt', store, validator, executor, clock)

  await assert.rejects(worker.runOnce(), /queda simulada/)
  assert.equal(executor.calls, 1)
  assert.equal(store.executionReceipts.size, 1)
  assert.equal((await store.findById(task.taskId))?.status, 'verifying')

  clock.advance(5_001)
  const completed = await worker.runOnce()
  assert.equal(completed?.status, 'succeeded')
  assert.equal(executor.calls, 1)
  assert.equal(store.outbox.size, 0)
})

test('falha transitoria vira nova estrategia somente depois da reentrega da mesma mensagem', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const clock = new MutableClock()
  const executor = new CountingExecutor(2)
  const authority = new PermittingAuthorityProvider(() => clock.now())
  const manager = new TaskManager(store, validator, authority, clock)
  const task = await manager.submit(await requestFixture('retry-0001'))
  const worker = new TaskWorker('worker-retry', store, validator, executor, clock)

  const deliveryDeferred = await worker.runOnce()
  assert.equal(deliveryDeferred?.status, 'running')
  assert.equal((deliveryDeferred?.state.usage.attemptCount), 1)

  clock.advance(1_001)
  const retryScheduled = await worker.runOnce()
  assert.equal(retryScheduled?.status, 'planning')
  assert.equal(retryScheduled?.executionEpoch, 2)
  assert.equal(store.outbox.size, 0)

  const runningAgain = await manager.reconcile(task.taskId)
  assert.equal(runningAgain?.status, 'running', JSON.stringify(runningAgain?.reconciliation))
  assert.equal(runningAgain?.state.usage.attemptCount, 2)
  const planRefs = runningAgain?.state.ledger.planRefs as JsonObject[]
  assert.equal(planRefs.length, 2)
  assert.notEqual(
    (planRefs[0]?.strategyFingerprint as JsonObject).value,
    (planRefs[1]?.strategyFingerprint as JsonObject).value
  )

  const completed = await worker.runOnce()
  assert.equal(completed?.status, 'succeeded')
  assert.equal(completed?.result?.status, 'succeeded')
  assert.equal((completed?.result?.execution as JsonObject).attemptCount, 2)
  assert.equal(executor.calls, 3)
})

test('orcamento esgotado produz falha terminal e remove a mensagem da fila', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const clock = new MutableClock()
  const executor = new CountingExecutor(Number.POSITIVE_INFINITY)
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider(() => clock.now()), clock)
  const task = await manager.submit(await requestFixture('exhausted-0001'))
  const worker = new TaskWorker('worker-exhausted', store, validator, executor, clock)

  await worker.runOnce()
  clock.advance(1_001)
  assert.equal((await worker.runOnce())?.status, 'planning')
  const retried = await manager.reconcile(task.taskId)
  assert.equal(retried?.status, 'running', JSON.stringify(retried?.reconciliation))

  await worker.runOnce()
  clock.advance(1_001)
  const failed = await worker.runOnce()
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.result?.status, 'failed')
  assert.equal((failed?.result?.execution as JsonObject).attemptCount, 2)
  assert.equal((failed?.result?.failure as JsonObject).retryable, false)
  assert.equal(store.outbox.size, 0)
  validator.taskState(failed!.state)
  validator.assert('task-result', failed?.result)
})

test('heartbeat conserva o lease e recibo rejeita worker sem a posse da mensagem', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const clock = new MutableClock()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider(() => clock.now()), clock)
  await manager.submit(await requestFixture('heartbeat-0001'))
  const claimed = await store.claimOutbox('worker-owner', 30_000, clock.now())
  assert.ok(claimed)

  clock.advance(10_000)
  await store.extendOutboxLease(claimed.outboxId, claimed.claimToken, 30_000, clock.now())
  assert.equal(await store.claimOutbox('worker-competing', 30_000, new Date(clock.now().getTime() + 20_001)), null)

  const payload: JsonObject = { kind: 'inspection-completed', inspection: {} }
  await assert.rejects(
    store.saveExecutionReceipt({
      receiptId: 'receipt-heartbeat-0001',
      outboxId: claimed.outboxId,
      taskId: claimed.taskId,
      executionEpoch: 1,
      payload,
      payloadFingerprint: fingerprint(payload),
      recordedAt: clock.now().toISOString()
    }, 'worker-sem-o-lease', clock.now()),
    /Lease da outbox/
  )
})
