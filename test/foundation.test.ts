import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { PreflightAdmissionError, TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { permittingDecision } from '../src/application/authorization.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { fingerprint, scopeKey, stableId } from '../src/domain/fingerprint.js'
import type { CasMutation, JsonObject, TaskRequest } from '../src/domain/types.js'
import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { AuthorityProviderError, ConcurrentTaskUpdateError } from '../src/ports/task-store.js'
import type { AuthorityProvider } from '../src/ports/task-store.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()

class MutableClock {
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

async function requestFixture(): Promise<TaskRequest> {
  const path = join(root, 'contratos', 'exemplos', 'task-request-inspecao-executavel.json')
  const request = JSON.parse(await readFile(path, 'utf8')) as TaskRequest
  request.context.references[0]!.uri = pathToFileURL(root).href
  return request
}

test('a primeira tarefa executa o ciclo real de leitura até TaskResult', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const worker = new TaskWorker('worker-test-001', store, validator, new ReadOnlyContractInspectionExecutor())

  const scheduled = await manager.submit(await requestFixture())
  assert.equal(scheduled.status, 'running')
  assert.equal(scheduled.stateRevision, 4)
  assert.equal(store.plans.size, 1)
  assert.equal(store.authorizations.size, 1)
  assert.equal(store.outbox.size, 1)

  const completed = await worker.runOnce()
  assert.ok(completed)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.stateRevision, 6)
  assert.equal(completed.result?.status, 'succeeded')
  assert.equal(store.outbox.size, 0)
  validator.taskState(completed.state)
  validator.assert('task-result', completed.result)
})

test('a mesma chave idempotente devolve a tarefa existente sem duplicar execução', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const request = await requestFixture()
  const first = await manager.submit(request)
  const second = await manager.submit(structuredClone(request))
  assert.equal(second.taskId, first.taskId)
  assert.equal(store.tasks.size, 1)
  assert.equal(store.outbox.size, 1)
})

for (const scenario of [
  { eventKind: 'planning-started', partialStatus: 'accepted' },
  { eventKind: 'plan-authorized', partialStatus: 'planning' },
  { eventKind: 'execution-scheduled', partialStatus: 'ready' }
] as const) {
  test(`reinício retoma tarefa em ${scenario.partialStatus} sem duplicar efeitos`, async () => {
    const validator: ContractValidator = await ContractValidator.create(root)
    const store = new FailOnceTaskStore(scenario.eventKind)
    const request = await requestFixture()
    request.requestId = `req-restart-${scenario.partialStatus}-0001`
    request.idempotencyKey = `restart-${scenario.partialStatus}-0001`
    const clock = new MutableClock()
    const authority = new PermittingAuthorityProvider(() => clock.now())
    const firstProcess = new TaskManager(store, validator, authority, clock)

    const interrupted = await firstProcess.submit(request)
    const taskId = stableId('task', request.idempotencyKey)
    assert.equal(interrupted.status, scenario.partialStatus)
    assert.equal(interrupted.reconciliation?.failureCount, 1)

    clock.advance(1_001)
    const restartedProcess = new TaskManager(store, validator, authority, clock)
    const resumed = await restartedProcess.reconcile(taskId)
    assert.equal(resumed?.status, 'running')
    assert.equal(resumed?.stateRevision, 4)
    assert.equal(store.tasks.size, 1)
    assert.equal(store.plans.size, 1)
    assert.equal(store.authorizations.size, 1)
    assert.equal(store.outbox.size, 1)
  })
}

test('lease impede dupla retomada e expira depois de uma queda', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new FailOnceTaskStore('planning-started')
  const request = await requestFixture()
  request.requestId = 'req-reconciliation-lease-0001'
  request.idempotencyKey = 'reconciliation-lease-0001'
  const clock = new MutableClock()
  await new TaskManager(store, validator, new PermittingAuthorityProvider(() => clock.now()), clock).submit(request)
  const taskId = stableId('task', request.idempotencyKey)
  clock.advance(1_001)
  const now = clock.now()
  const firstClaim = await store.claimReconciliation(taskId, 'crashed-process', 1_000, now)
  assert.ok(firstClaim)
  assert.equal(await store.claimReconciliation(taskId, 'competing-process', 1_000, new Date(now.getTime() + 999)), null)
  assert.ok(await store.claimReconciliation(taskId, 'restarted-process', 1_000, new Date(now.getTime() + 1_001)))
})

test('dois reconciliadores concorrentes consultam o Omni apenas uma vez', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new FailOnceTaskStore('plan-authorized')
  let authorityCalls = 0
  const authorizationRequestIds: string[] = []
  const clock = new MutableClock()
  const authority: AuthorityProvider = {
    async evaluate(request: JsonObject) {
      authorityCalls += 1
      authorizationRequestIds.push(String(request.authorizationRequestId))
      await new Promise((resolve) => setTimeout(resolve, 10))
      return permittingDecision(request, clock.now())
    }
  }
  const request = await requestFixture()
  request.requestId = 'req-concurrent-reconciliation-0001'
  request.idempotencyKey = 'concurrent-reconciliation-0001'
  await new TaskManager(store, validator, authority, clock).submit(request)
  assert.equal(authorityCalls, 1)
  const taskId = stableId('task', request.idempotencyKey)
  clock.advance(1_001)

  await Promise.all([
    new TaskManager(store, validator, authority, clock).reconcile(taskId),
    new TaskManager(store, validator, authority, clock).reconcile(taskId)
  ])

  assert.equal(authorityCalls, 2)
  assert.equal(new Set(authorizationRequestIds).size, 1)
  assert.equal((await store.findById(taskId))?.status, 'running')
  assert.equal(store.outbox.size, 1)
})

test('falha temporária do Omni aplica backoff persistente e retoma sem intervenção', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const clock = new MutableClock()
  let calls = 0
  const authority: AuthorityProvider = {
    async evaluate(request: JsonObject) {
      calls += 1
      if (calls === 1) {
        throw new AuthorityProviderError('authority-provider-unavailable', true, 'Omni reiniciando.')
      }
      return permittingDecision(request, clock.now())
    }
  }
  const request = await requestFixture()
  request.requestId = 'req-authority-backoff-0001'
  request.idempotencyKey = 'authority-backoff-0001'
  const manager = new TaskManager(store, validator, authority, clock)

  const deferred = await manager.submit(request)
  assert.equal(deferred.status, 'planning')
  assert.equal(deferred.reconciliation?.failureCount, 1)
  assert.equal(Date.parse(String(deferred.reconciliation?.retryAt)), clock.now().getTime() + 1_000)
  assert.equal((await manager.reconcile(deferred.taskId))?.status, 'planning')
  assert.equal(calls, 1)

  clock.advance(1_001)
  const resumed = await manager.reconcile(deferred.taskId)
  assert.equal(resumed?.status, 'running')
  assert.equal(resumed?.reconciliation, undefined)
  assert.equal(calls, 2)
  assert.equal(store.outbox.size, 1)
})

test('falhas temporárias repetidas aumentam o backoff sem criar estado paralelo', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const clock = new MutableClock()
  let calls = 0
  const authority: AuthorityProvider = {
    async evaluate() {
      calls += 1
      throw new AuthorityProviderError('authority-provider-unavailable', true, 'Omni ainda indisponível.')
    }
  }
  const request = await requestFixture()
  request.requestId = 'req-authority-exponential-backoff-0001'
  request.idempotencyKey = 'authority-exponential-backoff-0001'
  const manager = new TaskManager(store, validator, authority, clock)
  const first = await manager.submit(request)
  assert.equal(first.reconciliation?.failureCount, 1)

  clock.advance(1_001)
  const second = await manager.reconcile(first.taskId)
  assert.equal(second?.status, 'planning')
  assert.equal(second?.reconciliation?.failureCount, 2)
  assert.equal(Date.parse(String(second?.reconciliation?.retryAt)), clock.now().getTime() + 2_000)
  assert.equal(calls, 2)
  assert.equal(second?.state.lifecycle.state, 'planning')
})

test('negação do Omni produz TaskResult blocked e retoma somente pela fase segura', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const clock = new MutableClock()
  let permit = false
  const authority: AuthorityProvider = {
    async evaluate(request: JsonObject) {
      const decision = permittingDecision(request, clock.now())
      if (permit) return decision
      decision.outcome = 'deny'
      decision.actionDecisions = (decision.actionDecisions as JsonObject[]).map((item) => ({
        ...item,
        outcome: 'deny',
        reasonCode: 'outside-delegated-authority',
        requiredControls: []
      }))
      delete decision.decisionFingerprint
      decision.decisionFingerprint = fingerprint(decision)
      return decision
    }
  }
  const request = await requestFixture()
  request.requestId = 'req-authority-block-0001'
  request.idempotencyKey = 'authority-block-0001'
  const manager = new TaskManager(store, validator, authority, clock)

  const blocked = await manager.submit(request)
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.result?.status, 'blocked')
  assert.equal((blocked.result?.inputRequired as JsonObject).code, 'block-authorization-denied')
  assert.equal(store.outbox.size, 0)
  validator.taskState(blocked.state)
  validator.assert('task-result', blocked.result)

  permit = true
  clock.advance(1_000)
  const resumed = await manager.resume(blocked.taskId)
  assert.equal(resumed?.status, 'running')
  assert.equal(resumed?.stateRevision, 6)
  assert.equal(store.outbox.size, 1)
  assert.equal(store.events.filter((item) => item.kind === 'condition-restored').length, 1)
  const completed = await new TaskWorker(
    'worker-after-block',
    store,
    validator,
    new ReadOnlyContractInspectionExecutor(),
    clock
  ).runOnce()
  assert.equal(completed?.status, 'succeeded')
  assert.equal((completed?.result?.stateRef as JsonObject).emissionSequence, 2)
  assert.equal(
    (completed?.result?.stateRef as JsonObject).supersedesResultId,
    blocked.result?.resultId
  )
  assert.equal((completed?.state.ledger.resultRefs as JsonObject[]).length, 2)
})

test('autorização vencida é renovada para o mesmo plano antes da execução', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new FailOnceTaskStore('execution-scheduled')
  const clock = new MutableClock()
  const authority = new PermittingAuthorityProvider(() => clock.now())
  const request = await requestFixture()
  request.requestId = 'req-authorization-refresh-0001'
  request.idempotencyKey = 'authorization-refresh-0001'
  const firstProcess = new TaskManager(store, validator, authority, clock)
  const interrupted = await firstProcess.submit(request)
  assert.equal(interrupted.status, 'ready')
  assert.equal(store.authorizations.size, 1)
  assert.equal(store.outbox.size, 0)

  clock.advance(6 * 60_000)
  const restartedProcess = new TaskManager(store, validator, authority, clock)
  const resumed = await restartedProcess.reconcile(interrupted.taskId)
  assert.equal(resumed?.status, 'running')
  assert.equal(resumed?.stateRevision, 5)
  assert.equal(store.plans.size, 1)
  assert.equal(store.authorizations.size, 2)
  assert.equal(store.outbox.size, 1)
  assert.equal(store.events.filter((item) => item.kind === 'authorization-refreshed').length, 1)
  const requestIds = [...store.authorizations.values()].map((item) => String(item.request.authorizationRequestId))
  assert.equal(new Set(requestIds).size, 2)
})

test('a mesma chave idempotente com outro TaskRequest é conflito, não repetição', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const request = await requestFixture()
  await manager.submit(request)
  const conflicting = structuredClone(request)
  conflicting.objective = 'Outra intenção tentou reutilizar a mesma chave de execução.'
  await assert.rejects(
    manager.submit(conflicting),
    (error: unknown) => error instanceof PreflightAdmissionError && error.code === 'preflight-execution-conflict'
  )
  assert.equal(store.tasks.size, 1)
  assert.equal(store.outbox.size, 1)
})

test('CAS rejeita escritor que leu revisão antiga', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const task = await manager.submit(await requestFixture())
  const stale = structuredClone(task)
  stale.stateRevision += 1
  stale.state.stateRevision += 1
  stale.updatedAt = new Date().toISOString()
  await assert.rejects(
    store.compareAndSwap({
      expectedRevision: task.stateRevision - 1,
      next: stale,
      event: {
        eventId: 'event-stale-writer-0001',
        kind: 'stale-write',
        occurredAt: stale.updatedAt,
        payload: {}
      }
    }),
    ConcurrentTaskUpdateError
  )
})

test('scopeKey independe da ordem das referências e separa conjuntos de projetos', async () => {
  const first = await requestFixture()
  first.context.references.push({
    refId: 'ref-second-project-workspace',
    uri: 'file:///C:/Work/Second',
    kind: 'workspace',
    sensitivity: 'internal'
  })
  const reordered = structuredClone(first)
  reordered.context.references.reverse()
  assert.equal(scopeKey(first), scopeKey(reordered))
  reordered.context.references[0]!.uri = 'file:///C:/Work/Third'
  assert.notEqual(scopeKey(first), scopeKey(reordered))
})

test('dois workers reivindicam mensagens diferentes', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const first = await requestFixture()
  const second = await requestFixture()
  second.requestId = 'req-20260831-runtime-inspection-002'
  second.idempotencyKey = 'inspect-overcore-runtime-foundation-20260831-second'
  await manager.submit(first)
  await manager.submit(second)
  const a = await store.claimOutbox('worker-a', 30_000)
  const b = await store.claimOutbox('worker-b', 30_000)
  assert.ok(a)
  assert.ok(b)
  assert.notEqual(a.outboxId, b.outboxId)
})

test('migração declara PostgreSQL, CAS documental e fila concorrente', async () => {
  const sql = await readFile(join(root, 'migrations', '001_task_runtime.sql'), 'utf8')
  const storeSource = await readFile(join(root, 'src', 'infrastructure', 'database', 'postgres-task-store.ts'), 'utf8')
  assert.match(sql, /jsonb/i)
  assert.match(sql, /scope_key/i)
  assert.match(storeSource, /state_revision=\$2/)
  assert.match(storeSource, /state_revision=\$8/)
  assert.match(storeSource, /FOR UPDATE SKIP LOCKED/)
  assert.doesNotMatch(sql, /sqlite/i)
})

test('migração de reconciliação cria lease expirável sem inventar outro estado de tarefa', async () => {
  const sql = await readFile(join(root, 'migrations', '003_task_reconciliation_lease.sql'), 'utf8')
  assert.match(sql, /reconciliation_token/i)
  assert.match(sql, /reconciliation_until\s+timestamptz/i)
  assert.match(sql, /status IN \('accepted', 'planning', 'ready'\)/i)
  assert.doesNotMatch(sql, /ADD VALUE|CREATE TYPE/i)
})

test('migração de recovery torna backoff persistente e observável fora do Task State', async () => {
  const sql = await readFile(join(root, 'migrations', '004_reconciliation_backoff.sql'), 'utf8')
  assert.match(sql, /reconciliation_failure_count/i)
  assert.match(sql, /reconciliation_retry_at\s+timestamptz/i)
  assert.match(sql, /reconciliation_error_fingerprint/i)
  assert.match(sql, /não altera o estado de domínio/i)
  assert.doesNotMatch(sql, /ADD VALUE|CREATE TYPE/i)
})

test('migration de execução persiste recibo idempotente antes da verificação', async () => {
  const sql = await readFile(join(root, 'migrations', '005_execution_receipts.sql'), 'utf8')
  assert.match(sql, /overcore_task_execution_receipts/i)
  assert.match(sql, /outbox_id text NOT NULL UNIQUE/i)
  assert.match(sql, /payload_fingerprint/i)
  assert.match(sql, /execution_epoch/i)
})

test('migração de recibos admite a projeção de substituição reversível sem alterar estados', async () => {
  const sql = await readFile(join(root, 'migrations', '007_file_replacement_receipts.sql'), 'utf8')
  assert.match(sql, /DROP CONSTRAINT IF EXISTS overcore_task_execution_receipts_payload_check/i)
  assert.match(sql, /file-replacement-completed/i)
  assert.doesNotMatch(sql, /overcore_tasks\s+SET|UPDATE\s+overcore_tasks/i)
})

test('fixture da primeira tarefa continua válida no contrato público', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const request: unknown = await requestFixture()
  validator.taskRequest(request)
  assert.equal((request as JsonObject).contractVersion, '1.0')
})

test('documento do Omni com fingerprint válido no formato mas falso não ativa o plano', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const dishonestProvider: AuthorityProvider = {
    async evaluate(request: JsonObject) {
      const decision = permittingDecision(request)
      decision.decisionFingerprint = {
        algorithm: 'sha256-jcs-v1',
        value: `sha256:${'0'.repeat(64)}`
      }
      return decision
    }
  }
  const manager = new TaskManager(store, validator, dishonestProvider)
  const blocked = await manager.submit(await requestFixture())
  assert.equal(store.outbox.size, 0)
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.result?.status, 'blocked')
  assert.equal((blocked.result?.inputRequired as JsonObject).code, 'block-authority-provider-invalid')
  validator.taskState(blocked.state)
  validator.assert('task-result', blocked.result)
})
