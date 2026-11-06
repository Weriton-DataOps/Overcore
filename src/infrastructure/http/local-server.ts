import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { EXECUTION_VIEW_VERSION, executionDetail, executionSummary } from '../../application/execution-view.js'
import type { TaskManager } from '../../application/task-manager.js'
import type { TaskWorker } from '../../application/task-worker.js'
import type { TaskStatus } from '../../domain/types.js'

const MAX_BODY_BYTES = 1_048_576
const TASK_STATUSES: readonly TaskStatus[] = [
  'accepted', 'planning', 'ready', 'running', 'verifying', 'blocked', 'cancelling', 'succeeded', 'failed', 'cancelled'
]

function listQuery(url: URL): { limit: number; statuses?: TaskStatus[] } {
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? 50 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit deve ser inteiro entre 1 e 200.')
  const rawState = url.searchParams.get('state')
  if (rawState === null || rawState === '') return { limit }
  const statuses = rawState.split(',').map((item) => item.trim())
  const unknown = statuses.filter((item) => !TASK_STATUSES.includes(item as TaskStatus))
  if (unknown.length > 0) throw new Error(`Estado desconhecido: ${unknown.join(', ')}.`)
  return { limit, statuses: statuses as TaskStatus[] }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization
  if (!value?.startsWith('Bearer ')) return false
  const provided = Buffer.from(value.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Corpo excede 1 MiB.')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export interface LocalServerOptions {
  /** O serve legado deixa o /health aberto; na casa do Omni toda rota exige token (decisão A do E3). */
  openHealth?: boolean
  /** Corpo de GET /v1/saude, sem o iniciado_em; ausente, a rota não existe. */
  health?: { agente: string; versao: string; motor: string }
}

export function createLocalServer(manager: TaskManager, worker: TaskWorker, token: string,
  capabilities: readonly string[] = [], readValidationEvidence?: () => Promise<unknown>,
  options: LocalServerOptions = {}) {
  // This identity belongs to this process, not to a task completed by an older runtime.
  const startedAt = new Date().toISOString()
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (options.openHealth !== false && request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, { status: 'ok', service: 'overcore-task-manager', version: 1 })
        return
      }
      if (!authorized(request, token)) {
        send(response, 401, { error: 'unauthorized' })
        return
      }
      if (options.health && request.method === 'GET' && url.pathname === '/v1/saude') {
        send(response, 200, { ...options.health, iniciado_em: startedAt })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
        send(response, 200, {
          service: 'overcore-task-manager', protocolVersion: 1, startedAt,
          observedAt: new Date().toISOString(), capabilities: [...capabilities],
          scope: 'runtime-capabilities-not-task-success'
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/validation-evidence') {
        send(response, 200, readValidationEvidence ? await readValidationEvidence() : {
          protocolVersion: 1, status: 'unavailable', scope: 'historical-integration-evidence', evidence: []
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/tasks') {
        send(response, 410, {
          error: 'direct-admission-retired',
          message: 'Admita o TaskRequest persistido por POST /v1/preflight/{reportId}/admit.'
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/preflight') {
        const envelope = await jsonBody(request)
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
          throw new Error('Preflight espera { draft }.')
        }
        const body = envelope as { draft?: unknown; previousReports?: unknown }
        if (!('draft' in body)) throw new Error('Campo draft ausente no pedido de Preflight.')
        if ('previousReports' in body) {
          throw new Error('Não envie previousReports; o Overcore recupera o histórico persistido.')
        }
        const report = await manager.prepare(body.draft)
        send(response, 200, report)
        return
      }
      const admissionMatch = url.pathname.match(/^\/v1\/preflight\/([A-Za-z0-9._:-]+)\/admit$/)
      if (request.method === 'POST' && admissionMatch?.[1]) {
        const task = await manager.admitPrepared(admissionMatch[1])
        send(response, 202, {
          reportId: admissionMatch[1],
          taskId: task.taskId,
          status: task.status,
          stateRevision: task.stateRevision
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/executions') {
        const query = listQuery(url)
        const tasks = await manager.list(query)
        send(response, 200, {
          viewVersion: EXECUTION_VIEW_VERSION,
          observedAt: new Date().toISOString(),
          limit: query.limit,
          executions: tasks.map(executionSummary)
        })
        return
      }
      const executionMatch = url.pathname.match(/^\/v1\/executions\/([A-Za-z0-9._:-]+)$/)
      if (request.method === 'GET' && executionMatch?.[1]) {
        const task = await manager.get(executionMatch[1])
        send(response, task ? 200 : 404, task
          ? { viewVersion: EXECUTION_VIEW_VERSION, observedAt: new Date().toISOString(), execution: executionDetail(task) }
          : { error: 'not-found' })
        return
      }
      const taskMatch = url.pathname.match(/^\/v1\/tasks\/([A-Za-z0-9._:-]+)$/)
      if (request.method === 'GET' && taskMatch?.[1]) {
        const task = await manager.get(taskMatch[1])
        send(response, task ? 200 : 404, task ?? { error: 'not-found' })
        return
      }
      const resumeMatch = url.pathname.match(/^\/v1\/tasks\/([A-Za-z0-9._:-]+)\/resume$/)
      if (request.method === 'POST' && resumeMatch?.[1]) {
        const task = await manager.resume(resumeMatch[1])
        send(response, task ? 202 : 404, task ?? { error: 'not-found' })
        return
      }
      const cancelMatch = url.pathname.match(/^\/v1\/tasks\/([A-Za-z0-9._:-]+)\/cancel$/)
      if (request.method === 'POST' && cancelMatch?.[1]) {
        const task = await manager.cancel(cancelMatch[1])
        send(response, task ? 202 : 404, task ?? { error: 'not-found' })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/work-once') {
        const reconciliation = await manager.reconcilePending()
        const task = await worker.runOnce()
        send(response, 200, {
          reconciliation,
          ...(task ? { taskId: task.taskId, status: task.status } : { status: 'idle' })
        })
        return
      }
      send(response, 404, { error: 'not-found' })
    } catch (error) {
      // `Error` genérico não é código: quem lê a API precisa de algo estável para ramificar.
      const name = error instanceof Error ? error.name : 'Error'
      send(response, 400, {
        error: name === 'Error' ? 'invalid-request' : name,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })
}
