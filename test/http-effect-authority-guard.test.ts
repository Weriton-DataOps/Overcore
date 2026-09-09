import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import { HttpEffectAuthorityGuard } from '../src/infrastructure/authority/http-effect-authority-guard.js'
import type { EffectAuthorizationCheck } from '../src/ports/effect-journal-store.js'

const token = 'overcore-effect-guard-local-token-0001'

function check(): EffectAuthorizationCheck {
  return {
    taskId: 'task-effect-guard-0001',
    effectId: 'effect-effect-guard-0001',
    effectKey: 'task-effect-guard-0001/change-file',
    resourceRef: 'resource-effect-guard-file',
    targetUri: 'file:///never-sent-to-omni.txt',
    operation: 'filesystem.modify',
    intentFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'1'.repeat(64)}` },
    enforcementId: 'authenf-effect-guard-0001',
    expiresAt: '2026-09-09T13:00:00.000Z',
    requiredControls: [
      'checkpoint-before-mutation', 'verify-after-effect',
      'reconcile-before-retry', 'revocation-check-before-effect'
    ],
    actionId: 'action-effect-guard-0001',
    authorizationRequest: {
      contractVersion: '1.0',
      authorizationRequestId: 'authreq-effect-guard-0001'
    }
  }
}

async function serverFor(
  responder: (body: Record<string, unknown>) => { status: number, body: Record<string, unknown> }
): Promise<{ endpoint: URL, close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const result = responder(body)
    response.writeHead(result.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(result.body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}/v1/authority/revalidate-effect`),
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())) }
  }
}

test('guardiao HTTP envia somente a ligacao do efeito e aceita confirmacao ativa do Omni', async () => {
  let observed: Record<string, unknown> | undefined
  const server = await serverFor((body) => {
    observed = body
    return {
      status: 200,
      body: {
        contractVersion: '1.0',
        revalidationId: 'effect-revalidation-0001',
        checkedAt: '2026-09-09T12:00:00.000Z',
        status: 'active',
        authorizationRequestId: 'authreq-effect-guard-0001',
        effectBinding: {
          actionId: 'action-effect-guard-0001',
          effectKey: 'task-effect-guard-0001/change-file',
          resourceRef: 'resource-effect-guard-file',
          operation: 'filesystem.modify'
        },
        evidenceFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'2'.repeat(64)}` }
      }
    }
  })
  try {
    const evidence = await new HttpEffectAuthorityGuard(server.endpoint, token).assertActive(check())
    assert.equal(evidence.evidenceId, 'effect-revalidation-0001')
    assert.equal(observed?.contractVersion, '1.0')
    const effect = observed?.effect as Record<string, unknown>
    assert.deepEqual(effect, {
      actionId: 'action-effect-guard-0001',
      effectKey: 'task-effect-guard-0001/change-file',
      resourceRef: 'resource-effect-guard-file',
      operation: 'filesystem.modify'
    })
    assert.doesNotMatch(JSON.stringify(observed), /never-sent-to-omni|intentFingerprint|desiredContent/)
  } finally {
    await server.close()
  }
})

test('guardiao HTTP falha fechado se a resposta ativa nao confirma o mesmo efeito', async () => {
  const server = await serverFor(() => ({
    status: 200,
    body: {
      contractVersion: '1.0', status: 'active', revalidationId: 'effect-revalidation-0002',
      checkedAt: '2026-09-09T12:00:00.000Z', authorizationRequestId: 'authreq-effect-guard-0001',
      effectBinding: {
        actionId: 'action-effect-guard-0001', effectKey: 'other-effect',
        resourceRef: 'resource-effect-guard-file', operation: 'filesystem.modify'
      },
      evidenceFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'3'.repeat(64)}` }
    }
  }))
  try {
    await assert.rejects(
      new HttpEffectAuthorityGuard(server.endpoint, token).assertActive(check()),
      /nao confirmou/i
    )
  } finally {
    await server.close()
  }
})

test('guardiao HTTP exige pedido e actionId para nunca revalidar um efeito solto', async () => {
  const server = await serverFor(() => ({ status: 500, body: {} }))
  try {
    const incomplete = check()
    delete incomplete.authorizationRequest
    await assert.rejects(
      new HttpEffectAuthorityGuard(server.endpoint, token).assertActive(incomplete),
      /pedido de autorizacao e actionId/i
    )
  } finally {
    await server.close()
  }
})
