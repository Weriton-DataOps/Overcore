import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ContractValidator } from './contracts/validator.js'
import { TaskManager } from './application/task-manager.js'
import { TaskWorker } from './application/task-worker.js'
import { ReadOnlyContractInspectionExecutor } from './application/inspection-executor.js'
import type { JsonObject } from './domain/types.js'
import { createPostgresPool, migrate } from './infrastructure/database/postgres.js'
import { serve } from './infrastructure/runtime/serve.js'
import { InMemoryTaskStore } from './testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from './testing/permitting-authority-provider.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

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

async function preflight(path: string | undefined): Promise<void> {
  if (!path) throw new Error('Uso: overcore preflight <task-draft.json>')
  const draft = JSON.parse(await readFile(path, 'utf8')) as unknown
  process.stdout.write(`${JSON.stringify(await api('/v1/preflight', 'POST', { draft }), null, 2)}\n`)
}

async function admit(reportId: string | undefined): Promise<void> {
  if (!reportId) throw new Error('Uso: overcore admit <report-id>')
  const encoded = encodeURIComponent(reportId)
  process.stdout.write(`${JSON.stringify(await api(`/v1/preflight/${encoded}/admit`, 'POST'), null, 2)}\n`)
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

async function resume(taskId: string | undefined): Promise<void> {
  if (!taskId) throw new Error('Uso: overcore resume <task-id>')
  process.stdout.write(`${JSON.stringify(await api(`/v1/tasks/${encodeURIComponent(taskId)}/resume`, 'POST'), null, 2)}\n`)
}

async function cancel(taskId: string | undefined): Promise<void> {
  if (!taskId) throw new Error('Uso: overcore cancel <task-id>')
  process.stdout.write(`${JSON.stringify(await api(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, 'POST'), null, 2)}\n`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'serve') return serve(projectRoot)
  if (command === 'migrate') return runMigration()
  if (command === 'demo-inspection') return demoInspection()
  if (command === 'preflight') return preflight(process.argv[3])
  if (command === 'admit') return admit(process.argv[3])
  if (command === 'demo-preflight') return demoPreflight(process.argv[3])
  if (command === 'status') return status(process.argv[3])
  if (command === 'resume') return resume(process.argv[3])
  if (command === 'cancel') return cancel(process.argv[3])
  if (command === 'work-once') {
    process.stdout.write(`${JSON.stringify(await api('/v1/work-once', 'POST'), null, 2)}\n`)
    return
  }
  throw new Error('Uso: overcore <serve|migrate|preflight|admit|status|resume|cancel|work-once|demo-preflight|demo-inspection>')
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
