import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { query } from '@anthropic-ai/claude-agent-sdk'

import { AnthropicAgentSdkRuntime } from '../src/infrastructure/agent-runtime/anthropic-agent-sdk.js'
import { HttpAuthorityProvider } from '../src/infrastructure/authority/http-authority-provider.js'
import { createPostgresPool, migrate } from '../src/infrastructure/database/postgres.js'
import { PostgresTaskStore } from '../src/infrastructure/database/postgres-task-store.js'
import { exercisePreflightRoundtrip } from '../test/support/preflight-roundtrip.js'

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(resolveExit, 5_000)
    timeout.unref()
    child.once('exit', () => { clearTimeout(timeout); resolveExit() })
    child.kill('SIGTERM')
  })
}

async function startOmni(repository: string, token: string) {
  const child = spawn(process.execPath, [join(repository, 'adaptadores', 'overcore-authority-http.mjs')], {
    cwd: repository, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OMNI_AUTHORITY_PROVIDER_TOKEN: token, OMNI_AUTHORITY_PROVIDER_PORT: '0' }
  })
  try {
    const endpoint = await new Promise<URL>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Omni não iniciou a porta de autoridade em 10s.')), 10_000)
      let output = ''
      const fail = (error: Error) => { clearTimeout(timeout); reject(error) }
      child.once('error', fail)
      child.once('exit', (code) => fail(new Error(`Omni encerrou com código ${String(code)}.`)))
      // Drain stderr without writing potential private environment diagnostics into reports.
      child.stderr.resume()
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        if (!output.includes('\n')) return
        try {
          const payload = JSON.parse(output.split('\n')[0]!) as { status?: string; url?: string }
          assert.equal(payload.status, 'ready')
          const url = new URL(payload.url!)
          assert.equal(url.hostname, '127.0.0.1')
          assert.equal(url.protocol, 'http:')
          clearTimeout(timeout)
          resolveReady(url)
        } catch { fail(new Error('Omni devolveu inicialização inválida.')) }
      })
    })
    return { child, endpoint }
  } catch (error) { await stop(child); throw error }
}

test('Preflight multirrevisão por HTTP + PostgreSQL isolado + Claude OAuth + autoridade Omni real', { timeout: 240_000 }, async (t) => {
  assert.equal(process.env.OVERCORE_RUN_PREFLIGHT_ROUNDTRIP, 'I_UNDERSTAND_LOGIN_USAGE', 'Gate exige opt-in explícito para consumo do login.')
  const connectionString = process.env.OVERCORE_TEST_DATABASE_URL
  const omniRoot = process.env.OVERCORE_OMNI_REPOSITORY_PATH
  assert.ok(connectionString && omniRoot, 'Configure o banco de testes e a pasta canônica do Omni.')
  const connection = new URL(connectionString)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname), 'Somente PostgreSQL local de testes.')
  assert.equal(decodeURIComponent(connection.pathname), '/overcore_test', 'O gate não toca no banco de operação.')
  const schema = `overcore_preflight_e2e_${randomBytes(8).toString('hex')}`
  assert.match(schema, /^overcore_preflight_e2e_[a-f0-9]{16}$/)
  const admin = createPostgresPool(connectionString)
  connection.searchParams.set('options', `-c search_path=${schema}`)
  const pool = createPostgresPool(connection.href)
  let schemaCreated = false
  let omni: Awaited<ReturnType<typeof startOmni>> | undefined
  let lastStage = 'database-isolation'
  let success = false
  const observations: Array<{ stage: string; details?: Record<string, unknown> }> = []
  let result: Awaited<ReturnType<typeof exercisePreflightRoundtrip>> | undefined
  const outputDirectory = join(process.cwd(), '.overcore-runtime', 'evaluations', 'preflight')
  const reportPath = join(outputDirectory, `roundtrip-${Date.now()}.json`)
  let cleanupComplete = false
  try {
    const database = await admin.query<{ database: string }>('SELECT current_database() AS database')
    assert.equal(database.rows[0]?.database, 'overcore_test')
    await admin.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    const isolated = await pool.query<{ schema: string }>('SELECT current_schema() AS schema')
    assert.equal(isolated.rows[0]?.schema, schema)
    await migrate(pool, process.cwd())
    const token = randomBytes(32).toString('hex')
    omni = await startOmni(omniRoot, token)
    const runtime = new AnthropicAgentSdkRuntime((input) => query({ ...input, options: { ...input.options, persistSession: false } }))
    result = await exercisePreflightRoundtrip({
      projectRoot: process.cwd(), createStore: () => new PostgresTaskStore(pool), runtime,
      authority: new HttpAuthorityProvider(omni.endpoint, token),
      onStage(stage, details) {
        lastStage = stage
        observations.push({ stage, ...(details ? { details } : {}) })
        t.diagnostic(stage)
      }
    })
    const execution = observations.find((entry) => entry.stage === 'runtime-result' && entry.details?.purpose === 'execution')
    const toolEvents = execution?.details?.tools as Array<Record<string, unknown>> | undefined
    assert.ok(toolEvents)
    const requestedTools = toolEvents.filter((event) => event.type === 'tool-requested' && event.source === 'assistant-stream').map((event) => String(event.toolName)).sort()
    const checkedTools = toolEvents.filter((event) => event.type === 'tool-allowed' && event.source === 'pre-tool-use').map((event) => String(event.toolName)).sort()
    assert.ok(requestedTools.includes('Read'), 'O modelo deve realmente ler, não apenas declarar a inspeção.')
    assert.deepEqual(checkedTools, requestedTools, 'Cada ferramenta precisa passar pela rechecagem do crachá, sem depender de canUseTool.')
    const stored = await pool.query<{ drafts: number; revisions: number; tasks: number; receipts: number; authorizations: number }>(
      `SELECT (SELECT count(*)::int FROM overcore_preflight_streams) AS drafts,
       (SELECT count(*)::int FROM overcore_preflight_revisions) AS revisions,
       (SELECT count(*)::int FROM overcore_tasks) AS tasks,
       (SELECT count(*)::int FROM overcore_task_execution_receipts) AS receipts,
       (SELECT count(*)::int FROM overcore_task_authorizations) AS authorizations`
    )
    assert.deepEqual(stored.rows[0], { drafts: 1, revisions: 2, tasks: 1, receipts: 1, authorizations: 1 })
    assert.equal((result.authorizationDecisions[0]?.issuer as Record<string, unknown>)?.providerId, 'omni-authority-provider')
    assert.equal(result.authorizationDecisions[0]?.outcome, 'permit-with-constraints')
    success = true
  } finally {
    try {
      await pool.end()
      if (schemaCreated) {
        // Exact schema generated and created by this test; never public or a user-provided name.
        assert.match(schema, /^overcore_preflight_e2e_[a-f0-9]{16}$/)
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      }
      cleanupComplete = true
    } finally {
      await admin.end()
      if (omni) await stop(omni.child)
      await mkdir(outputDirectory, { recursive: true })
      await writeFile(reportPath, JSON.stringify({
        formatVersion: 1, generatedAt: new Date().toISOString(), success, lastStage, cleanupComplete, observations,
        database: 'overcore_test', isolation: 'temporary-schema',
        ...(result ? { result } : {}),
        note: 'Omni real como autoridade; cliente e decisões do proprietário são roteiro de teste, não conversa real.'
      }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
      t.diagnostic(`Relatório: ${reportPath}`)
    }
  }
})
