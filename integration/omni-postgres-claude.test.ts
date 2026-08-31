import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { AgentAssistedContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ContractValidator } from '../src/contracts/validator.js'
import type { JsonObject, TaskRequest } from '../src/domain/types.js'
import { AnthropicAgentSdkRuntime } from '../src/infrastructure/agent-runtime/anthropic-agent-sdk.js'
import { HttpAuthorityProvider } from '../src/infrastructure/authority/http-authority-provider.js'
import { createPostgresPool, migrate } from '../src/infrastructure/database/postgres.js'
import { PostgresTaskStore } from '../src/infrastructure/database/postgres-task-store.js'

const root = process.cwd()

async function startOmni(repository: string, token: string): Promise<{
  process: ChildProcessWithoutNullStreams
  endpoint: URL
}> {
  const entrypoint = join(repository, 'adaptadores', 'overcore-authority-http.mjs')
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repository,
    env: {
      ...process.env,
      OMNI_AUTHORITY_PROVIDER_TOKEN: token,
      OMNI_AUTHORITY_PROVIDER_PORT: '0'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let output = ''
  let errors = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { errors += chunk })
  const endpoint = await new Promise<URL>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Omni nao iniciou a porta de autoridade: ${errors}`)), 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      const line = output.split(/\r?\n/u).find((item) => item.trim().length > 0)
      if (!line) return
      try {
        const ready = JSON.parse(line) as { status?: string; url?: string }
        if (ready.status !== 'ready' || typeof ready.url !== 'string') throw new Error('ready invalido')
        clearTimeout(timeout)
        resolveReady(new URL(ready.url))
      }
      catch (error) {
        clearTimeout(timeout)
        reject(new Error(`Omni devolveu inicializacao invalida: ${String(error)}; stderr=${errors}`))
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Omni encerrou antes de ficar pronto (code=${String(code)}): ${errors}`))
    })
  })
  return { process: child, endpoint }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000))
  ])
}

test('PostgreSQL, Omni real e Claude Agent SDK concluem uma tarefa somente leitura', {
  timeout: 180_000
}, async () => {
  if (process.env.OVERCORE_RUN_LIVE_E2E !== 'I_UNDERSTAND_LOGIN_USAGE') {
    throw new Error('Gate nao executado: defina OVERCORE_RUN_LIVE_E2E=I_UNDERSTAND_LOGIN_USAGE.')
  }
  const connectionString = process.env.OVERCORE_TEST_DATABASE_URL
  if (!connectionString) throw new Error('OVERCORE_TEST_DATABASE_URL nao foi definida.')
  const omniRepository = process.env.OVERCORE_OMNI_REPOSITORY_PATH
  if (!omniRepository) throw new Error('OVERCORE_OMNI_REPOSITORY_PATH nao foi definida.')

  const token = randomBytes(32).toString('hex')
  const omni = await startOmni(omniRepository, token)
  const pool = createPostgresPool(connectionString)
  let taskId: string | undefined
  try {
    await migrate(pool, root)
    const validator = await ContractValidator.create(root)
    const store = new PostgresTaskStore(pool)
    const authority = new HttpAuthorityProvider(omni.endpoint, token)
    const manager = new TaskManager(store, validator, authority)
    const worker = new TaskWorker(
      'worker-e2e-omni-claude',
      store,
      validator,
      new AgentAssistedContractInspectionExecutor(new AnthropicAgentSdkRuntime())
    )
    const fixture = JSON.parse(
      await readFile(join(root, 'contratos', 'exemplos', 'task-request-inspecao-executavel.json'), 'utf8')
    ) as TaskRequest
    const suffix = randomUUID().replaceAll('-', '')
    fixture.requestId = `req-e2e-omni-claude-${suffix}`
    fixture.idempotencyKey = `e2e-omni-claude-${suffix}`
    fixture.context.references[0]!.uri = pathToFileURL(root).href

    const scheduled = await manager.submit(fixture)
    taskId = scheduled.taskId
    assert.equal(scheduled.status, 'running')
    const completed = await worker.runOnce()
    assert.equal(completed?.status, 'succeeded')
    const attempt = (completed?.state.ledger.attempts as JsonObject[])[0]
    const runtime = attempt?.runtimeBinding as JsonObject
    assert.equal(runtime.authSource, 'oauth-login')
    assert.equal(runtime.engine, 'anthropic-claude-agent-sdk')
    assert.equal(typeof runtime.sessionId, 'string')
    assert.equal((completed?.result?.evidence as unknown[]).length, 3)

    const authorization = await pool.query<{
      provider_id: string
      outcome: string
      auth_source: string
    }>(
      `SELECT
         decision_document -> 'issuer' ->> 'providerId' AS provider_id,
         decision_document ->> 'outcome' AS outcome,
         state_document -> 'ledger' -> 'attempts' -> 0 -> 'runtimeBinding' ->> 'authSource' AS auth_source
       FROM overcore_task_authorizations a
       JOIN overcore_tasks t ON t.task_id = a.task_id
       WHERE a.task_id = $1`,
      [taskId]
    )
    assert.equal(authorization.rows[0]?.provider_id, 'omni-authority-provider')
    assert.equal(authorization.rows[0]?.outcome, 'permit-with-constraints')
    assert.equal(authorization.rows[0]?.auth_source, 'oauth-login')
  }
  finally {
    if (taskId) {
      await pool.query('DELETE FROM overcore_task_outbox WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_task_authorizations WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_task_plans WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_task_events WHERE task_id=$1', [taskId])
      await pool.query('DELETE FROM overcore_tasks WHERE task_id=$1', [taskId])
    }
    await pool.end()
    await stop(omni.process)
  }
})
