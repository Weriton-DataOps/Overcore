import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { AdaptiveDiscovery } from '../../src/application/adaptive-discovery.js'
import { BaselineDiscovery } from '../../src/application/baseline-discovery.js'
import { AgentAssistedContractInspectionExecutor } from '../../src/application/inspection-executor.js'
import { TaskManager } from '../../src/application/task-manager.js'
import { TaskPreflight } from '../../src/application/task-preflight.js'
import { TaskWorker } from '../../src/application/task-worker.js'
import { ContractValidator } from '../../src/contracts/validator.js'
import { fingerprint } from '../../src/domain/fingerprint.js'
import type { JsonObject, StoredTask, TaskDraft, TaskReadinessReport } from '../../src/domain/types.js'
import { ClaudeDiscoveryAdvisor } from '../../src/infrastructure/discovery/claude-discovery-advisor.js'
import { createLocalServer } from '../../src/infrastructure/http/local-server.js'
import type { AgentRuntimePort, AgentRuntimeResult } from '../../src/ports/agent-runtime.js'
import type { AuthorityProvider, TaskStore } from '../../src/ports/task-store.js'

export interface RoundtripOptions {
  projectRoot: string
  createStore(): TaskStore
  runtime: AgentRuntimePort
  authority: AuthorityProvider
  onStage?(stage: string, details?: JsonObject): void
}

/** Test client, NOT an Omni conversation or a new production integration. */
export async function exercisePreflightRoundtrip(options: RoundtripOptions) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'overcore-preflight-roundtrip-')))
  const token = randomBytes(24).toString('hex')
  const suffix = randomUUID().replaceAll('-', '')
  const validator: ContractValidator = await ContractValidator.create(options.projectRoot)
  const validationFailures: string[] = []
  const assertContract = validator.assert.bind(validator)
  validator.assert = (contract, document) => {
    try { assertContract(contract, document) }
    catch (error) {
      validationFailures.push(error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  const calls: Array<{ purpose: string; result: AgentRuntimeResult }> = []
  const authorizationDecisions: JsonObject[] = []
  const stages: string[] = []
  const stage = (name: string, details?: JsonObject) => { stages.push(name); options.onStage?.(name, details) }
  const runtime: AgentRuntimePort = {
    async run(request, sink, signal) {
      const result = await options.runtime.run(request, sink, signal)
      calls.push({ purpose: request.purpose ?? 'execution', result })
      stage('runtime-result', {
        purpose: request.purpose ?? 'execution', model: result.model, authSource: result.authSource,
        durationMs: result.durationMs, usage: result.usage, permissionDenials: result.permissionDenials,
        tools: result.events.filter((event) => event.type.startsWith('tool-')).map((event) => ({ type: event.type, ...event.data }))
      })
      return result
    }
  }
  const authority: AuthorityProvider = {
    async evaluate(request, signal) {
      const result = await options.authority.evaluate(request, signal)
      authorizationDecisions.push(result)
      return result
    }
  }
  let server: ReturnType<typeof createLocalServer> | undefined
  let endpoint = ''
  const close = async () => {
    if (!server) return
    const closing = server
    server = undefined
    await new Promise<void>((resolveClosed, reject) => closing.close((error) => error ? reject(error) : resolveClosed()))
  }
  const start = async () => {
    const store = options.createStore()
    const discovery = new AdaptiveDiscovery(new BaselineDiscovery(), new ClaudeDiscoveryAdvisor(runtime, directory))
    const manager = new TaskManager(store, validator, authority, undefined, new TaskPreflight(validator, discovery, store))
    const worker = new TaskWorker(`worker-roundtrip-${suffix}`, store, validator, new AgentAssistedContractInspectionExecutor(runtime))
    server = createLocalServer(manager, worker, token)
    await new Promise<void>((resolveListening, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolveListening)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    endpoint = `http://127.0.0.1:${address.port}`
  }
  const api = async (path: string, body?: unknown, method: 'POST' | 'GET' = 'POST') => {
    const response = await fetch(`${endpoint}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(150_000)
    })
    return { status: response.status, body: await response.json() as JsonObject }
  }
  try {
    await mkdir(join(directory, 'contratos'))
    const files = ['sample-request.schema.json', 'sample-result.schema.json']
    const contents = files.map((name) => JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `urn:overcore:roundtrip:${name}`,
      type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id']
    }))
    await Promise.all(files.map((name, index) => writeFile(join(directory, 'contratos', name), contents[index]!, { flag: 'wx' })))
    const draft: TaskDraft = {
      contractVersion: '1.0', draftId: `draft-roundtrip-${suffix}`, revision: 1,
      idempotencyKey: `prepare-roundtrip-${suffix}`, executionIdempotencyKey: `execute-roundtrip-${suffix}`,
      correlationId: `corr-roundtrip-${suffix}`, createdAt: new Date().toISOString(),
      client: { id: 'client-roundtrip-test', kind: 'automation' },
      objective: 'Inspecionar todos os arquivos *.schema.json apenas no nível raiz da pasta contratos do repositório referenciado, sem recursão, somente leitura.',
      context: {
        summary: 'O alvo e a leitura estão definidos. Falta escolher como provar o sucesso e em qual formato entregar o resultado. Não criar, corrigir ou publicar arquivos.',
        references: [{ refId: 'ref-roundtrip-repository', uri: pathToFileURL(directory).href, kind: 'repository', sensitivity: 'public' }], assumptions: []
      },
      knownConstraints: [{ id: 'constraint-read-only', kind: 'technical', description: 'Somente leitura dos contratos; resultado em memória, sem alteração nem publicação.' }],
      knownAcceptanceCriteria: [],
      discoveryAuthority: { mode: 'inspect-only', grants: [{ resourceRef: 'ref-roundtrip-repository', operations: [{ name: 'filesystem.read', effect: 'read' }] }] },
      availableExecutionAuthority: {
        mode: 'proceed-within-scope', grants: [{ resourceRef: 'ref-roundtrip-repository', operations: ['filesystem.read'] }],
        expansionBoundaries: ['destructive', 'irreversible', 'financial', 'privilege-expansion', 'external-publication', 'secret-access']
      },
      executionBudget: { source: { kind: 'policy-default', sourceId: 'policy-roundtrip-test', sourceVersion: '1.0', sourceDigest: fingerprint('roundtrip-v1').value }, limits: { maxDurationMs: 300_000, maxAttempts: 1, maxParallelism: 1, maxCostUsd: 0.75 } },
      decisionAnswers: [], preflightBudget: { maxDurationMs: 60_000, maxInspectionOperations: 10 }
    }
    await start()
    stage('initial-preflight')
    const firstResponse = await api('/v1/preflight', { draft })
    assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse.body))
    validator.preflightReport(draft, firstResponse.body)
    const first = firstResponse.body as TaskReadinessReport
    stage('initial-decision-package', { status: first.status, questions: first.requiredDecisions.map((d) => ({ topic: d.topic, question: d.question })) })
    assert.equal(first.status, 'decisions-required')
    assert.ok(first.requiredDecisions.length >= 2)
    assert.equal(first.preparedRequest, undefined)
    assert.equal(calls.length, 1, 'Fallback ou erro de login não vale como avaliação assistida.')
    assert.equal(calls[0]!.purpose, 'discovery')
    assert.equal(await options.createStore().findByIdempotencyKey(draft.executionIdempotencyKey), null)
    assert.equal(authorizationDecisions.length, 0)
    stage('replay-and-premature-admission')
    assert.deepEqual((await api('/v1/preflight', { draft })).body, first)
    const premature = await api(`/v1/preflight/${first.reportId}/admit`)
    assert.equal(premature.status, 400)
    assert.equal(calls.length, 1)
    assert.equal(authorizationDecisions.length, 0)

    // A new HTTP server/Manager/Store must recover history from persistence.
    await close()
    await start()
    stage('restarted-service-and-invalid-answers')
    assert.deepEqual((await api('/v1/preflight', { draft })).body, first)
    const revised = structuredClone(draft)
    revised.revision = 2
    revised.createdAt = new Date().toISOString()
    revised.context.summary = 'Decisão pré-definida pelo cenário de teste: ler todos os *.schema.json somente no nível raiz de contratos, sem recursão; provar JSON legível e additionalProperties=false na raiz. Resultado JSON em memória, sem artefato persistente, com uma linha por arquivo: nome, digest SHA-256, readable boolean e rootClosed boolean; incluir schemaCount e capturedAt. Não descrever propriedades, tipos, required ou referências internas: a profundidade é somente os dois checks definidos. Sem modificações, publicação ou outros diretórios.'
    revised.knownAcceptanceCriteria = [
      { id: 'criterion-json-readable', description: 'Todos os *.schema.json de contratos são JSON legível.', verificationHint: 'test' },
      { id: 'criterion-root-closed', description: 'Todos os contratos declaram additionalProperties=false na raiz.', verificationHint: 'schema' }
    ]
    revised.executionHints = { priority: 'normal', expectedOutputKind: 'no-artifact' }
    revised.decisionAnswers = first.requiredDecisions.map((decision, index) => {
      // Test-owner choice: a memory-only result must NOT blindly accept the
      // baseline recommendation to produce a persistent artifact.
      const options = decision.options as JsonObject[]
      const nonPersistent = options.find((option) => option.label === 'Não produzir artefato')
      return {
        answerId: `answer-roundtrip-${index}`, decisionId: decision.decisionId,
        sourceReport: { reportId: first.reportId, draftRevision: first.draftRevision, draftFingerprint: first.draftFingerprint, reportFingerprint: fingerprint(first) },
        selectedOptionId: nonPersistent?.optionId ?? decision.recommendedOptionId, answeredAt: revised.createdAt, answeredBy: 'owner-test-scenario'
      }
    })
    const tampered = structuredClone(revised)
    const tamperedSource = tampered.decisionAnswers[0]!.sourceReport as JsonObject
    tamperedSource.reportFingerprint = fingerprint('unrelated-report')
    assert.equal((await api('/v1/preflight', { draft: tampered })).status, 400)
    const incomplete = structuredClone(revised)
    incomplete.decisionAnswers.pop()
    assert.equal((await api('/v1/preflight', { draft: incomplete })).status, 400)
    assert.equal(calls.length, 1)
    assert.equal(await options.createStore().findPreflightRevision(draft.draftId, 2), null)

    stage('answered-revision')
    const secondResponse = await api('/v1/preflight', { draft: revised })
    assert.equal(secondResponse.status, 200, JSON.stringify(secondResponse.body))
    validator.preflightReport(revised, secondResponse.body)
    const second = secondResponse.body as TaskReadinessReport
    stage('answered-decision-package', { status: second.status, questions: second.requiredDecisions.map((d) => ({ topic: d.topic, question: d.question })) })
    assert.equal(second.status, 'ready', JSON.stringify(second.requiredDecisions))
    assert.equal(second.appliedDecisionAnswers.length, first.requiredDecisions.length)
    assert.equal(second.preparedRequest?.idempotencyKey, draft.executionIdempotencyKey)
    assert.equal(second.preparedRequest?.expectedOutput.kind, 'no-artifact')
    assert.equal(calls.length, 2)
    assert.equal(authorizationDecisions.length, 0)
    assert.deepEqual((await api('/v1/preflight', { draft: revised })).body, second)
    assert.equal(calls.length, 2)
    assert.deepEqual(await options.createStore().findPreflightReport(first.reportId), first)

    stage('concurrent-admission-with-omni-authority')
    const admissions = await Promise.all([api(`/v1/preflight/${second.reportId}/admit`), api(`/v1/preflight/${second.reportId}/admit`)])
    for (const admission of admissions) assert.equal(admission.status, 202, JSON.stringify(admission.body))
    assert.equal(admissions[0]!.body.taskId, admissions[1]!.body.taskId)
    const taskId = String(admissions[0]!.body.taskId)
    assert.ok(authorizationDecisions.length > 0)
    const admittedTask = await options.createStore().findById(taskId)
    assert.equal(admittedTask?.status, 'running', JSON.stringify({ reconciliation: admittedTask?.reconciliation, validationFailures, state: admittedTask?.state }))
    stage('execution-and-idempotent-result')
    const worked = await api('/v1/work-once')
    assert.equal(worked.body.status, 'succeeded', JSON.stringify(worked.body))
    assert.equal(worked.body.taskId, taskId)
    const fetched = await api(`/v1/tasks/${taskId}`, undefined, 'GET')
    assert.equal(fetched.status, 200)
    const completed = fetched.body as unknown as StoredTask
    assert.equal(completed.status, 'succeeded')
    const attempts = completed.state.ledger.attempts
    assert.ok(Array.isArray(attempts))
    assert.equal(attempts.length, 1)
    assert.equal(calls.filter((call) => call.purpose === 'execution').length, 1)
    assert.equal(calls.filter((call) => call.purpose === 'discovery').length, 2)
    assert.ok(calls.every((call) => call.result.authSource === 'oauth-login'))
    assert.ok(calls.every((call) => call.result.permissionDenials === 0), JSON.stringify(calls.flatMap((call) => call.result.events.filter((event) => event.type === 'tool-denied'))))
    assert.ok(calls.filter((call) => call.purpose === 'discovery').every((call) => !call.result.events.some((event) => event.type === 'tool-requested')))
    assert.equal((await api('/v1/work-once')).body.status, 'idle')
    assert.equal((await api(`/v1/preflight/${second.reportId}/admit`)).body.taskId, taskId)
    assert.equal(calls.length, 3)
    for (const [index, name] of files.entries()) assert.equal(await readFile(join(directory, 'contratos', name), 'utf8'), contents[index])
    stage('completed')
    return {
      draftId: draft.draftId, taskId, statuses: [first.status, second.status, completed.status],
      reportIds: [first.reportId, second.reportId], initialQuestions: first.requiredDecisions.map((d) => ({ topic: d.topic, question: d.question })),
      answeredDecisions: second.appliedDecisionAnswers.length, executionAttempts: attempts.length,
      authorizationDecisions: authorizationDecisions.map((d) => ({ issuer: d.issuer, outcome: d.outcome })),
      calls: calls.map(({ purpose, result }) => ({ purpose, model: result.model, authSource: result.authSource, durationMs: result.durationMs, usage: result.usage, permissionDenials: result.permissionDenials })),
      stages, fixtureFilesUnchanged: true,
      limitation: 'Cliente e respostas de teste; Omni real apenas como provedor de autoridade. Não comprova integração na conversa do Omni.'
    }
  } finally {
    await close()
    const resolved = await realpath(directory)
    assert.equal(dirname(resolved).toLowerCase(), (await realpath(tmpdir())).toLowerCase())
    assert.equal((await lstat(directory)).isSymbolicLink(), false)
    assert.equal(basename(resolved), basename(directory))
    assert.ok(basename(resolved).startsWith('overcore-preflight-roundtrip-'))
    await rm(resolved, { recursive: true, force: true })
  }
}
