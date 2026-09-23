import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { acceptedState } from '../src/application/state-builder.js'
import { fingerprint } from '../src/domain/fingerprint.js'
import type { StoredTask, TaskRequest } from '../src/domain/types.js'
import type { PostgresPool } from '../src/infrastructure/database/postgres.js'
import { PostgresTaskStore } from '../src/infrastructure/database/postgres-task-store.js'
import { DuplicateTaskError } from '../src/ports/task-store.js'

async function task(): Promise<StoredTask> {
  const request = JSON.parse(await readFile(join(process.cwd(), 'contratos/exemplos/task-request-inspecao-executavel.json'), 'utf8')) as TaskRequest
  const now = new Date().toISOString()
  return {
    taskId: 'task-conflict-test', requestId: request.requestId, idempotencyKey: request.idempotencyKey,
    scopeKey: 'scope-conflict-test', status: 'accepted', stateRevision: 1, executionEpoch: 1,
    request, state: acceptedState('task-conflict-test', request, fingerprint(request), now), createdAt: now, updatedAt: now
  }
}

for (const constraint of ['overcore_tasks_pkey', 'overcore_tasks_request_id_key', 'overcore_tasks_idempotency_key_key', 'unrelated_unique_key']) {
  test(`conflito ${constraint} só converge se a chave idempotente for a mesma`, async () => {
    const incoming = await task()
    const error = Object.assign(new Error('duplicate key'), { code: '23505', constraint })
    for (const sameKeyExists of [true, false]) {
      let released = false
      let rolledBack = false
      let lookups = 0
      const pool = {
        async connect() {
          return {
            async query(sql: string, params?: unknown[]) {
              if (sql.includes('INSERT INTO overcore_tasks')) throw error
              if (sql === 'ROLLBACK') rolledBack = true
              if (sql.startsWith('SELECT task_id')) {
                assert.equal(rolledBack, true)
                assert.deepEqual(params, [incoming.idempotencyKey])
                lookups++
                return { rows: sameKeyExists ? [{ task_id: 'task-existing' }] : [] }
              }
              return { rows: [] }
            },
            release() { released = true }
          }
        },
        async query(): Promise<never> { throw new Error('Não pegar segunda conexão durante recuperação do conflito.') }
      } as unknown as PostgresPool
      const event = { eventId: 'event-test-create', kind: 'task-accepted', occurredAt: incoming.createdAt, payload: {} }
      const recognized = constraint !== 'unrelated_unique_key'
      await assert.rejects(new PostgresTaskStore(pool).create(incoming, event), (actual: unknown) => {
        if (recognized && sameKeyExists) return actual instanceof DuplicateTaskError && actual.existingTaskId === 'task-existing'
        return actual === error
      })
      assert.equal(released, true)
      assert.equal(lookups, recognized ? 1 : 0)
    }
  })
}
