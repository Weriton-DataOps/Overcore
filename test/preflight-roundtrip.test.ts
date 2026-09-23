import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TaskManager } from '../src/application/task-manager.js'
import { ContractValidator } from '../src/contracts/validator.js'
import type { TaskRequest } from '../src/domain/types.js'
import type { AgentRuntimePort } from '../src/ports/agent-runtime.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'
import { exercisePreflightRoundtrip } from './support/preflight-roundtrip.js'

test('HTTP liga decisões, revisão respondida, reinício e admissão concorrente sem duplicar tarefa', { timeout: 30_000 }, async () => {
  const store = new InMemoryTaskStore()
  const runtime: AgentRuntimePort = {
    async run(request) {
      if (request.purpose === 'discovery' && request.objective.includes('"revision":2')) {
        assert.match(request.objective, /"selectedOption":\{"label":"Não produzir artefato"/)
        assert.match(request.objective, /"expectedOutputKind":"no-artifact"/)
      }
      return {
        engine: 'anthropic-claude-agent-sdk', sdkVersion: 'fake', authSource: 'oauth-login',
        sessionId: 'session-test-roundtrip', model: 'fake', durationMs: 1, turns: 1,
        output: request.purpose === 'discovery' ? JSON.stringify({ summary: 'As lacunas já estão no pacote do baseline.', questions: [] }) : 'Dois contratos legíveis e fechados na raiz.',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0 },
        permissionDenials: 0, events: [{ sequence: 1, type: 'runtime-result', occurredAt: new Date().toISOString(), data: { status: 'succeeded' } }]
      }
    }
  }
  const result = await exercisePreflightRoundtrip({ projectRoot: process.cwd(), createStore: () => store, runtime, authority: new PermittingAuthorityProvider() })
  assert.deepEqual(result.statuses, ['decisions-required', 'ready', 'succeeded'])
  assert.equal(store.tasks.size, 1)
  assert.equal(store.preflightRevisions.size, 2)
  assert.equal(result.executionAttempts, 1)
})

test('decisão com orçamento incompatível explica o problema e não entra em retry do mesmo plano', async () => {
  const root = process.cwd()
  const request = JSON.parse(await readFile(join(root, 'contratos/exemplos/task-request-inspecao-executavel.json'), 'utf8')) as TaskRequest
  request.context.references[0]!.uri = pathToFileURL(root).href
  request.budget.maxDurationMs = 180_000
  const store = new InMemoryTaskStore()
  let calls = 0
  const permitting = new PermittingAuthorityProvider()
  const manager = new TaskManager(store, await ContractValidator.create(root), {
    async evaluate(input) { calls++; return permitting.evaluate(input) }
  })
  const result = await manager.submit(request)
  assert.equal(result.status, 'blocked')
  assert.equal(result.reconciliation, undefined)
  assert.match(JSON.stringify(result.result), /ampliou o orçamento temporal/)
  assert.deepEqual(await manager.reconcilePending(), [])
  assert.equal((await manager.submit(request)).taskId, result.taskId)
  assert.equal(calls, 1)
  assert.equal(store.outbox.size, 0)
})
