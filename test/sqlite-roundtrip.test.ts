import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentRuntimePort } from '../src/ports/agent-runtime.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'
import { exercisePreflightRoundtrip } from './support/preflight-roundtrip.js'
import { bancoMigrado, contar } from './support/sqlite-fixtures.js'

const runtime: AgentRuntimePort = {
  async run(request) {
    return {
      engine: 'anthropic-claude-agent-sdk', sdkVersion: 'fake', authSource: 'oauth-login',
      sessionId: 'session-sqlite-roundtrip', model: 'fake', durationMs: 1, turns: 1,
      output: request.purpose === 'discovery' ? JSON.stringify({ summary: 'As lacunas já estão no pacote do baseline.', questions: [] }) : 'Dois contratos legíveis e fechados na raiz.',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0 },
      permissionDenials: 0, events: [{ sequence: 1, type: 'runtime-result', occurredAt: new Date().toISOString(), data: { status: 'succeeded' } }]
    }
  }
}

test('o roundtrip HTTP completo roda no SQLite, com cada reinício abrindo um store novo sobre o mesmo arquivo', { timeout: 30_000 }, async () => {
  const arquivo = await bancoMigrado()
  let aberturas = 0
  const result = await exercisePreflightRoundtrip({
    projectRoot: process.cwd(),
    createStore: () => { aberturas += 1; return new SqliteTaskStore(arquivo, 'maquina-teste') },
    runtime,
    authority: new PermittingAuthorityProvider()
  })
  assert.deepEqual(result.statuses, ['decisions-required', 'ready', 'succeeded'])
  assert.equal(result.executionAttempts, 1)
  assert.ok(aberturas > 1, 'o roundtrip precisa reabrir o store para provar a persistência')
  assert.equal(contar(arquivo, 'overcore_tasks'), 1)
  assert.equal(contar(arquivo, 'overcore_preflight_revisions'), 2)
  assert.equal(contar(arquivo, 'overcore_task_execution_receipts'), 1)
})
