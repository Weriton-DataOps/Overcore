import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ContractValidator } from './contracts/validator.js'
import { TaskManager } from './application/task-manager.js'
import { TaskWorker } from './application/task-worker.js'
import {
  AgentAssistedContractInspectionExecutor,
  ReadOnlyContractInspectionExecutor
} from './application/inspection-executor.js'
import type { JsonObject } from './domain/types.js'
import { HttpAuthorityProvider } from './infrastructure/authority/http-authority-provider.js'
import { AnthropicAgentSdkRuntime } from './infrastructure/agent-runtime/anthropic-agent-sdk.js'
import { createPostgresPool, migrate } from './infrastructure/database/postgres.js'
import { PostgresTaskStore } from './infrastructure/database/postgres-task-store.js'
import { createLocalServer } from './infrastructure/http/local-server.js'
import { loadRuntimeConfig } from './infrastructure/runtime/config.js'
import { removeRuntimeDescriptor, writeRuntimeDescriptor } from './infrastructure/runtime/descriptor.js'
import { InMemoryTaskStore } from './testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from './testing/permitting-authority-provider.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

async function serve(): Promise<void> {
  const config = loadRuntimeConfig()
  const pool = createPostgresPool(config.databaseUrl)
  await migrate(pool, projectRoot)
  const validator = await ContractValidator.create(projectRoot)
  const store = new PostgresTaskStore(pool)
  const authority = new HttpAuthorityProvider(
    config.authorityProviderUrl,
    config.authorityProviderToken
  )
  const manager = new TaskManager(store, validator, authority)
  const worker = new TaskWorker(
    `worker-${process.pid}`,
    store,
    validator,
    new AgentAssistedContractInspectionExecutor(new AnthropicAgentSdkRuntime())
  )
  const server = createLocalServer(manager, worker, config.localToken)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Servidor local não informou porta TCP.')
  const descriptorPath = await writeRuntimeDescriptor(config.runtimeDirectory, {
    schemaVersion: 1,
    pid: process.pid,
    host: config.host,
    port: address.port,
    startedAt: new Date().toISOString()
  })
  process.stdout.write(`Overcore ativo em http://${config.host}:${address.port}\n`)

  let working = false
  const interval = setInterval(() => {
    if (working) return
    working = true
    void worker.runOnce()
      .catch((error: unknown) => process.stderr.write(`worker: ${error instanceof Error ? error.message : String(error)}\n`))
      .finally(() => { working = false })
  }, 500)
  interval.unref()

  const shutdown = async () => {
    clearInterval(interval)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeRuntimeDescriptor(descriptorPath)
    await pool.end()
  }
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
}

async function runMigration(): Promise<void> {
  const pool = createPostgresPool(process.env.OVERCORE_DATABASE_URL ?? '')
  try {
    await migrate(pool, projectRoot)
    process.stdout.write('Migrações do Overcore aplicadas.\n')
  } finally {
    await pool.end()
  }
}

async function demoInspection(): Promise<void> {
  const validator = await ContractValidator.create(projectRoot)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const worker = new TaskWorker('worker-demo', store, validator, new ReadOnlyContractInspectionExecutor())
  const fixturePath = join(projectRoot, 'contratos', 'exemplos', 'task-request-inspecao-executavel.json')
  const request = JSON.parse(await readFile(fixturePath, 'utf8')) as JsonObject
  const context = request.context as JsonObject
  const references = context.references as JsonObject[]
  if (references[0]) references[0].uri = pathToFileURL(projectRoot).href
  request.idempotencyKey = `${String(request.idempotencyKey)}-${Date.now()}`
  const scheduled = await manager.submit(request)
  const completed = await worker.runOnce()
  if (!completed) throw new Error('A demonstração não encontrou a tarefa agendada.')
  process.stdout.write(`${JSON.stringify({
    scheduled: { taskId: scheduled.taskId, status: scheduled.status, revision: scheduled.stateRevision },
    completed: { taskId: completed.taskId, status: completed.status, revision: completed.stateRevision },
    result: completed.result,
    warning: 'Demonstração usa memória e autoridade simulada; não aprova o gate PostgreSQL/Omni.'
  }, null, 2)}\n`)
}

async function runtimeEndpoint(): Promise<{ baseUrl: string; token: string }> {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) throw new Error('LOCALAPPDATA não foi definido.')
  const descriptor = JSON.parse(
    await readFile(join(localAppData, 'Overcore', 'runtime.json'), 'utf8')
  ) as { host?: string; port?: number }
  if (descriptor.host !== '127.0.0.1' || !Number.isInteger(descriptor.port)) {
    throw new Error('Descritor do runtime é inválido.')
  }
  const token = process.env.OVERCORE_LOCAL_TOKEN
  if (!token) throw new Error('OVERCORE_LOCAL_TOKEN não foi definido para a CLI.')
  return { baseUrl: `http://${descriptor.host}:${descriptor.port}`, token }
}

async function api(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
  const endpoint = await runtimeEndpoint()
  const response = await fetch(`${endpoint.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const result = await response.json() as unknown
  if (!response.ok) throw new Error(`Overcore respondeu HTTP ${response.status}: ${JSON.stringify(result)}`)
  return result
}

async function submit(path: string | undefined): Promise<void> {
  if (!path) throw new Error('Uso: overcore submit <task-request.json>')
  const document = JSON.parse(await readFile(path, 'utf8')) as unknown
  process.stdout.write(`${JSON.stringify(await api('/v1/tasks', 'POST', document), null, 2)}\n`)
}

async function preflight(path: string | undefined): Promise<void> {
  if (!path) throw new Error('Uso: overcore preflight <task-draft.json>')
  const draft = JSON.parse(await readFile(path, 'utf8')) as unknown
  process.stdout.write(`${JSON.stringify(await api('/v1/preflight', 'POST', { draft }), null, 2)}\n`)
}

async function demoPreflight(path: string | undefined): Promise<void> {
  if (!path) throw new Error('Uso: overcore demo-preflight <task-draft.json>')
  const validator = await ContractValidator.create(projectRoot)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(
    store,
    validator,
    new PermittingAuthorityProvider()
  )
  const draft = JSON.parse(await readFile(path, 'utf8')) as unknown
  process.stdout.write(`${JSON.stringify(await manager.prepare(draft), null, 2)}\n`)
}

async function status(taskId: string | undefined): Promise<void> {
  if (!taskId) throw new Error('Uso: overcore status <task-id>')
  process.stdout.write(`${JSON.stringify(await api(`/v1/tasks/${encodeURIComponent(taskId)}`, 'GET'), null, 2)}\n`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'serve') return serve()
  if (command === 'migrate') return runMigration()
  if (command === 'demo-inspection') return demoInspection()
  if (command === 'preflight') return preflight(process.argv[3])
  if (command === 'demo-preflight') return demoPreflight(process.argv[3])
  if (command === 'submit') return submit(process.argv[3])
  if (command === 'status') return status(process.argv[3])
  if (command === 'work-once') {
    process.stdout.write(`${JSON.stringify(await api('/v1/work-once', 'POST'), null, 2)}\n`)
    return
  }
  throw new Error('Uso: overcore <serve|migrate|preflight|submit|status|work-once|demo-preflight|demo-inspection>')
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
