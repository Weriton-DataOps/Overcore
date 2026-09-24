import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { permittingDecision } from '../src/application/authorization.js'
import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { BaselineDiscovery } from '../src/application/baseline-discovery.js'
import { TaskPreflight } from '../src/application/task-preflight.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { fingerprint } from '../src/domain/fingerprint.js'
import type { JsonObject, TaskDraft, TaskRequest } from '../src/domain/types.js'
import { HttpAuthorityProvider } from '../src/infrastructure/authority/http-authority-provider.js'
import { createLocalServer } from '../src/infrastructure/http/local-server.js'
import { AuthorityProviderError, type AuthorityProvider } from '../src/ports/task-store.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()

test('adaptador do Omni usa HTTP local e devolve decisão estruturada', async () => {
  const token = 'token-local-de-teste-comprido'
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const authorizationRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(permittingDecision(authorizationRequest)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const provider = new HttpAuthorityProvider(
      new URL(`http://127.0.0.1:${address.port}/v1/authority/evaluate`),
      token
    )
    const request: JsonObject = {
      authorizationRequestId: 'authreq-http-test-0001',
      requestBinding: {
        requestId: 'request-http-test-0001',
        requestFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'1'.repeat(64)}` },
        clientId: 'client-http-test-0001'
      },
      planBinding: {
        planId: 'plan-http-test-0001',
        planRevision: 1,
        planFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'2'.repeat(64)}` },
        strategyFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'3'.repeat(64)}` }
      },
      actions: [{ actionId: 'action-http-test-0001', scope: 'request-resource' }]
    }
    const decision = await provider.evaluate(request)
    assert.equal(decision.authorizationRequestId, request.authorizationRequestId)
    assert.equal(decision.outcome, 'permit-with-constraints')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('adaptador recusa endpoint que não seja loopback local', () => {
  assert.throws(
    () => new HttpAuthorityProvider(new URL('https://example.com/authority'), 'token-local-de-teste-comprido'),
    /loopback/
  )
})

test('adaptador classifica indisponibilidade temporária e respeita Retry-After', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2' })
    response.end(JSON.stringify({ error: 'restarting' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const provider = new HttpAuthorityProvider(
      new URL(`http://127.0.0.1:${address.port}/v1/authority/evaluate`),
      'token-http-retry-classification'
    )
    await assert.rejects(
      provider.evaluate({ authorizationRequestId: 'authreq-retry-after-0001' }),
      (error: unknown) =>
        error instanceof AuthorityProviderError &&
        error.retryable &&
        error.retryAfterMs === 2_000
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('porta local autentica e recusa a antiga admissão direta de TaskRequest', async () => {
  const token = 'token-api-local-de-teste'
  const validator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const worker = new TaskWorker(
    'worker-http-test',
    store,
    validator,
    new ReadOnlyContractInspectionExecutor()
  )
  const server = createLocalServer(manager, worker, token)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const health = await fetch(`${baseUrl}/health`)
    assert.equal(health.status, 200)
    const unauthorized = await fetch(`${baseUrl}/v1/tasks/task-inexistente`)
    assert.equal(unauthorized.status, 401)

    const fixturePath = join(root, 'contratos', 'exemplos', 'task-request-inspecao-executavel.json')
    const request = JSON.parse(await readFile(fixturePath, 'utf8')) as TaskRequest
    request.context.references[0]!.uri = pathToFileURL(root).href
    request.requestId = 'req-http-local-inspection-0001'
    request.idempotencyKey = 'http-local-inspection-0001'
    const admitted = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    })
    assert.equal(admitted.status, 410)
    const admittedBody = await admitted.json() as { error: string }
    assert.equal(admittedBody.error, 'direct-admission-retired')
    assert.equal(store.tasks.size, 0)
    assert.equal(store.outbox.size, 0)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('porta local executa Preflight sem admitir nem agendar a tarefa', async () => {
  const token = 'token-api-preflight-local'
  const validator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const clock = { now: () => new Date('2026-08-30T15:02:00Z') }
  const preflight = new TaskPreflight(validator, new BaselineDiscovery(), store, clock)
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider(), clock, preflight)
  const worker = new TaskWorker(
    'worker-http-preflight',
    store,
    validator,
    new ReadOnlyContractInspectionExecutor()
  )
  const server = createLocalServer(manager, worker, token)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const draft = JSON.parse(await readFile(join(root, 'contratos', 'exemplos', 'task-draft-incompleto.json'), 'utf8')) as unknown
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/preflight`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ draft })
    })
    assert.equal(response.status, 200)
    const report = await response.json() as { status: string; preparedRequest?: unknown }
    assert.equal(report.status, 'decisions-required')
    assert.equal(report.preparedRequest, undefined)
    const rejectedAdmission = await fetch(
      `http://127.0.0.1:${address.port}/v1/preflight/${encodeURIComponent(String((report as JsonObject).reportId))}/admit`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } }
    )
    assert.equal(rejectedAdmission.status, 400)
    assert.equal(store.tasks.size, 0)
    assert.equal(store.outbox.size, 0)
    assert.equal(store.preflightRevisions.size, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('porta local admite o request congelado pelo reportId sem dupla tarefa', async () => {
  const token = 'token-api-admission-local'
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const clock = { now: () => new Date('2026-08-30T15:02:00Z') }
  const manager = new TaskManager(
    store,
    validator,
    new PermittingAuthorityProvider(() => clock.now()),
    clock
  )
  const worker = new TaskWorker(
    'worker-http-admission',
    store,
    validator,
    new ReadOnlyContractInspectionExecutor()
  )
  const server = createLocalServer(manager, worker, token)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const draft = JSON.parse(
      await readFile(join(root, 'contratos', 'exemplos', 'task-draft-incompleto.json'), 'utf8')
    ) as TaskDraft
    draft.draftId = 'draft-http-ready-admission'
    draft.idempotencyKey = 'prepare-http-ready-admission'
    draft.executionIdempotencyKey = 'execute-http-ready-admission'
    draft.correlationId = 'corr-http-ready-admission'
    draft.context.summary = 'O escopo foi resolvido antes do Preflight HTTP.'
    draft.context.assumptions = []
    // This case exercises deterministic inspection, not the fixture's document-edit task.
    draft.knownAcceptanceCriteria = [
      { id: 'criterion-json-readable', description: 'Todos os arquivos são JSON legível.', verificationHint: 'test' },
      { id: 'criterion-root-closed', description: 'Todos declaram additionalProperties=false na raiz.', verificationHint: 'schema' }
    ]
    draft.executionHints = { expectedOutputKind: 'no-artifact' }
    const workspace = draft.context.references.find((item) => item.refId === 'ref-contract-docs-directory')
    assert.ok(workspace)
    workspace.kind = 'repository'
    workspace.uri = pathToFileURL(root).href
    const prepared = await fetch(`${baseUrl}/v1/preflight`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ draft })
    })
    assert.equal(prepared.status, 200)
    const report = await prepared.json() as { reportId: string; status: string }
    assert.equal(report.status, 'ready')

    const responses = await Promise.all([
      fetch(`${baseUrl}/v1/preflight/${encodeURIComponent(report.reportId)}/admit`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }
      }),
      fetch(`${baseUrl}/v1/preflight/${encodeURIComponent(report.reportId)}/admit`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }
      })
    ])
    assert.deepEqual(responses.map((item) => item.status), [202, 202])
    const admitted = await Promise.all(responses.map(async (item) => item.json() as Promise<{ taskId: string }>))
    const [firstAdmission, secondAdmission] = admitted
    assert.ok(firstAdmission && secondAdmission)
    assert.equal(firstAdmission.taskId, secondAdmission.taskId)
    assert.equal(store.tasks.size, 1)
    assert.equal(store.outbox.size, 1)
    const worked = await fetch(`${baseUrl}/v1/work-once`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }
    })
    assert.equal(worked.status, 200)
    const workedBody = await worked.json() as { taskId: string; status: string }
    assert.equal(workedBody.taskId, firstAdmission.taskId)
    assert.equal(workedBody.status, 'succeeded')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('porta local retoma bloqueio pela fase segura', async () => {
  const token = 'token-api-resume-local'
  const validator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  let permit = false
  const authority: AuthorityProvider = {
    async evaluate(request: JsonObject) {
      const decision = permittingDecision(request)
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
  const manager = new TaskManager(store, validator, authority)
  const worker = new TaskWorker(
    'worker-http-resume',
    store,
    validator,
    new ReadOnlyContractInspectionExecutor()
  )
  const request = JSON.parse(
    await readFile(join(root, 'contratos', 'exemplos', 'task-request-inspecao-executavel.json'), 'utf8')
  ) as TaskRequest
  request.context.references[0]!.uri = pathToFileURL(root).href
  request.requestId = 'req-http-resume-0001'
  request.idempotencyKey = 'http-resume-0001'
  const blocked = await manager.submit(request)
  assert.equal(blocked.status, 'blocked')
  permit = true

  const server = createLocalServer(manager, worker, token)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/tasks/${encodeURIComponent(blocked.taskId)}/resume`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } }
    )
    assert.equal(response.status, 202)
    const resumed = await response.json() as { status: string; stateRevision: number }
    assert.equal(resumed.status, 'running')
    assert.equal(resumed.stateRevision, 6)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
