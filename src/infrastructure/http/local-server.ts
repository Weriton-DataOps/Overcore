import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import type { TaskManager } from '../../application/task-manager.js'
import type { TaskWorker } from '../../application/task-worker.js'

const MAX_BODY_BYTES = 1_048_576

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

export function createLocalServer(manager: TaskManager, worker: TaskWorker, token: string,
  capabilities: readonly string[] = []) {
  // This identity belongs to this process, not to a task completed by an older runtime.
  const startedAt = new Date().toISOString()
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, { status: 'ok', service: 'overcore-task-manager', version: 1 })
        return
      }
      if (!authorized(request, token)) {
        send(response, 401, { error: 'unauthorized' })
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
      send(response, 400, {
        error: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })
}
