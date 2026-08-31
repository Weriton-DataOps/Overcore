import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { BaselineDiscovery } from '../src/application/baseline-discovery.js'
import { TaskPreflight, type PreflightClock } from '../src/application/task-preflight.js'
import { ContractValidationError, ContractValidator } from '../src/contracts/validator.js'
import { PreflightDomainError } from '../src/contracts/preflight-domain-validator.js'
import { fingerprint } from '../src/domain/fingerprint.js'
import type { JsonObject, TaskDraft, TaskReadinessReport } from '../src/domain/types.js'
import type { DiscoveryPort } from '../src/ports/discovery.js'
import { ConcurrentPreflightUpdateError } from '../src/ports/preflight-store.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'

const root = process.cwd()

class FixedClock implements PreflightClock {
  constructor(private readonly value: string) {}
  now(): Date { return new Date(this.value) }
}

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(root, 'contratos', 'exemplos', name), 'utf8')) as T
}

function resolvedRevision(draft: TaskDraft, report: TaskReadinessReport): TaskDraft {
  const decision = report.requiredDecisions[0]
  if (!decision) throw new Error('O relatório não possui decisão para o teste.')
  const resolved = structuredClone(draft)
  resolved.revision = 2
  resolved.createdAt = '2026-08-30T15:05:00Z'
  resolved.context.summary = 'A suposição aberta foi revisada e removida na segunda revisão.'
  resolved.context.assumptions = []
  resolved.decisionAnswers = [{
    answerId: 'answer-runtime-revision-0001',
    decisionId: String(decision.decisionId),
    sourceReport: {
      reportId: report.reportId,
      draftRevision: report.draftRevision,
      draftFingerprint: report.draftFingerprint,
      reportFingerprint: fingerprint(report)
    },
    selectedOptionId: String(decision.recommendedOptionId),
    answeredAt: '2026-08-30T15:04:00Z',
    answeredBy: 'owner-primary-user'
  }]
  return resolved
}

test('draft inválido é rejeitado antes de chamar Discovery', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const draft = await fixture<JsonObject>('task-draft-incompleto.json')
  delete draft.objective
  let discoveryCalled = false
  const discovery: DiscoveryPort = {
    async inspect() {
      discoveryCalled = true
      throw new Error('Discovery não deveria ser chamada.')
    }
  }
  const store = new InMemoryTaskStore()
  const preflight = new TaskPreflight(validator, discovery, store, new FixedClock('2026-08-30T15:02:00Z'))
  await assert.rejects(
    preflight.run(draft),
    (error: unknown) => error instanceof ContractValidationError && error.contract === 'task-draft'
  )
  assert.equal(discoveryCalled, false)
})

test('draft com suposição aberta devolve todas as decisões juntas e não executa', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const draft = await fixture<TaskDraft>('task-draft-incompleto.json')
  const store = new InMemoryTaskStore()
  const preflight = new TaskPreflight(validator, new BaselineDiscovery(), store, new FixedClock('2026-08-30T15:02:00Z'))
  const report = await preflight.run(draft)
  assert.equal(report.status, 'decisions-required')
  assert.equal(report.readinessChecks.length, 7)
  assert.equal(report.requiredDecisions.length, 1)
  assert.equal(report.preparedRequest, undefined)
  assert.equal(report.requiredDecisions[0]?.topic, 'scope')
  const repeated = await preflight.run(structuredClone(draft))
  assert.deepEqual(repeated, report)
  assert.equal(store.preflightRevisions.size, 1)
})

test('prazo encerrado devolve not-feasible com causa comprovada', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const draft = await fixture<TaskDraft>('task-draft-inviavel.json')
  const store = new InMemoryTaskStore()
  const preflight = new TaskPreflight(validator, new BaselineDiscovery(), store, new FixedClock('2026-08-30T15:10:01Z'))
  const report = await preflight.run(draft)
  assert.equal(report.status, 'not-feasible')
  assert.equal(report.failure?.code, 'preflight-deadline-expired')
  assert.equal(report.requiredDecisions.length, 0)
  assert.equal(report.preparedRequest, undefined)
})

test('nova instância recupera o relatório persistido e produz TaskRequest congelado', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const draft = await fixture<TaskDraft>('task-draft-incompleto.json')
  const first = await new TaskPreflight(
    validator,
    new BaselineDiscovery(),
    store,
    new FixedClock('2026-08-30T15:02:00Z')
  ).run(draft)
  const resolved = resolvedRevision(draft, first)
  const report = await new TaskPreflight(
    validator,
    new BaselineDiscovery(),
    store,
    new FixedClock('2026-08-30T15:07:00Z')
  ).run(resolved)
  assert.equal(report.status, 'ready')
  assert.equal(report.requiredDecisions.length, 0)
  assert.equal(report.appliedDecisionAnswers.length, 1)
  assert.equal(report.preparedRequest?.idempotencyKey, resolved.executionIdempotencyKey)
  assert.equal(report.preparedRequest?.expectedOutput.kind, 'repository-change')
  assert.ok(report.preparedRequest?.constraints.some((item) => String(item.id).startsWith('constraint-automatic-')))
  assert.equal(report.requestDerivations?.length, 9)
  assert.equal(store.preflightRevisions.size, 2)
  validator.preflightReport(resolved, report)
})

test('resposta não é aceita sem a revisão e o relatório persistidos', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const sourceStore = new InMemoryTaskStore()
  const draft = await fixture<TaskDraft>('task-draft-incompleto.json')
  const first = await new TaskPreflight(
    validator,
    new BaselineDiscovery(),
    sourceStore,
    new FixedClock('2026-08-30T15:02:00Z')
  ).run(draft)
  const resolved = resolvedRevision(draft, first)
  const emptyStore = new InMemoryTaskStore()
  const preflight = new TaskPreflight(
    validator,
    new BaselineDiscovery(),
    emptyStore,
    new FixedClock('2026-08-30T15:07:00Z')
  )
  await assert.rejects(
    preflight.run(resolved),
    (error: unknown) => error instanceof ConcurrentPreflightUpdateError
  )
})

test('revisão nova não pode apagar as decisões pendentes do relatório anterior', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const draft = await fixture<TaskDraft>('task-draft-incompleto.json')
  await new TaskPreflight(
    validator,
    new BaselineDiscovery(),
    store,
    new FixedClock('2026-08-30T15:02:00Z')
  ).run(draft)
  const evasive = structuredClone(draft)
  evasive.revision = 2
  evasive.createdAt = '2026-08-30T15:05:00Z'
  evasive.context.assumptions = []
  await assert.rejects(
    new TaskPreflight(
      validator,
      new BaselineDiscovery(),
      store,
      new FixedClock('2026-08-30T15:07:00Z')
    ).run(evasive),
    /responder exatamente todas as decisões/
  )
  assert.equal(store.preflightRevisions.size, 1)
})

test('duas revisões concorrentes diferentes não ocupam a mesma posição', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const draft = await fixture<TaskDraft>('task-draft-incompleto.json')
  const first = await new TaskPreflight(
    validator,
    new BaselineDiscovery(),
    store,
    new FixedClock('2026-08-30T15:02:00Z')
  ).run(draft)
  const left = resolvedRevision(draft, first)
  const right = structuredClone(left)
  right.context.summary = 'Outra sessão tentou ocupar a mesma revisão com conteúdo diferente.'
  const competing = await Promise.allSettled([
    new TaskPreflight(validator, new BaselineDiscovery(), store, new FixedClock('2026-08-30T15:07:00Z')).run(left),
    new TaskPreflight(validator, new BaselineDiscovery(), store, new FixedClock('2026-08-30T15:07:00Z')).run(right)
  ])
  assert.equal(competing.filter((item) => item.status === 'fulfilled').length, 1)
  const rejected = competing.find((item) => item.status === 'rejected')
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ConcurrentPreflightUpdateError)
  assert.equal(store.preflightRevisions.size, 2)
})

test('migração do Preflight separa corrente mutável de revisões append-only', async () => {
  const sql = await readFile(join(root, 'migrations', '002_preflight_runtime.sql'), 'utf8')
  assert.match(sql, /overcore_preflight_streams/)
  assert.match(sql, /overcore_preflight_revisions/)
  assert.match(sql, /jsonb/i)
  assert.match(sql, /append-only/)
  assert.match(sql, /BEFORE UPDATE/)
})

interface PatchOperation {
  op: 'add' | 'replace' | 'remove'
  path: string
  value?: unknown
}

function applyPatch(document: JsonObject, operation: PatchOperation): void {
  const parts = operation.path.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  let target: unknown = document
  for (const part of parts.slice(0, -1)) {
    target = Array.isArray(target) ? target[Number(part)] : (target as JsonObject)[part]
  }
  const key = parts.at(-1)
  if (key === undefined || target === null || typeof target !== 'object') throw new Error(`Patch inválido: ${operation.path}`)
  if (Array.isArray(target)) {
    if (operation.op === 'remove') target.splice(Number(key), 1)
    else if (key === '-') target.push(structuredClone(operation.value))
    else if (operation.op === 'add') target.splice(Number(key), 0, structuredClone(operation.value))
    else target[Number(key)] = structuredClone(operation.value)
    return
  }
  const record = target as JsonObject
  if (operation.op === 'remove') delete record[key]
  else record[key] = structuredClone(operation.value)
}

test('vetores adversariais do Preflight são executados pelo validador oficial', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const draft = await fixture<TaskDraft>('task-draft-resolvido.json')
  const base = await fixture<TaskReadinessReport>('task-readiness-ready.json')
  const vectors = JSON.parse(await readFile(join(root, 'contratos', 'testes', 'preflight-domain-mutations.json'), 'utf8')) as {
    cases: Array<{ caseId: string; patch: PatchOperation[]; expectedDomainCode: string }>
  }
  validator.preflightReport(draft, base)
  for (const vector of vectors.cases) {
    const mutated = structuredClone(base)
    for (const operation of vector.patch) applyPatch(mutated, operation)
    assert.throws(
      () => validator.preflightReport(draft, mutated),
      (error: unknown) => error instanceof PreflightDomainError && error.code === vector.expectedDomainCode,
      vector.caseId
    )
  }
})
