import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { PreflightAdmissionError, TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { permittingDecision } from '../src/application/authorization.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { scopeKey } from '../src/domain/fingerprint.js'
import type { JsonObject, TaskRequest } from '../src/domain/types.js'
import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { ConcurrentTaskUpdateError } from '../src/ports/task-store.js'
import type { AuthorityProvider } from '../src/ports/task-store.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()

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
  await assert.rejects(manager.submit(await requestFixture()), /decisionFingerprint não corresponde/)
  assert.equal(store.outbox.size, 0)
  assert.equal([...store.tasks.values()][0]?.status, 'planning')
})
