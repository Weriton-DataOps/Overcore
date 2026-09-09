import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { FileEffectHarness } from '../src/application/file-effect-harness.js'
import { fingerprint } from '../src/domain/fingerprint.js'
import { HttpEffectAuthorityGuard } from '../src/infrastructure/authority/http-effect-authority-guard.js'
import { FileCheckpointStore } from '../src/infrastructure/checkpoints/file-checkpoint-store.js'
import { InMemoryEffectJournalStore } from '../src/testing/in-memory-effect-journal-store.js'

async function startOmni(repository: string, token: string): Promise<{ process: ChildProcessWithoutNullStreams, endpoint: URL }> {
  const child = spawn(process.execPath, [join(repository, 'adaptadores', 'overcore-authority-http.mjs')], {
    cwd: repository,
    env: { ...process.env, OMNI_AUTHORITY_PROVIDER_TOKEN: token, OMNI_AUTHORITY_PROVIDER_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const endpoint = await new Promise<URL>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Omni nao iniciou: ${stderr}`)), 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.once('data', (chunk: string) => {
      clearTimeout(timeout)
      try {
        const ready = JSON.parse(chunk.trim()) as { url?: string }
        if (typeof ready.url !== 'string') throw new Error('URL ausente')
        resolveReady(new URL(ready.url))
      } catch (error) {
        reject(new Error(`Inicializacao Omni invalida: ${String(error)}; ${stderr}`))
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Omni encerrou antes de iniciar (${String(code)}): ${stderr}`))
    })
  })
  return { process: child, endpoint }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
}

test('Omni real revalida a escrita reversivel do Harness imediatamente antes do efeito', { timeout: 30_000 }, async () => {
  if (process.env.OVERCORE_RUN_OMNI_EFFECT_E2E !== 'I_UNDERSTAND_LOCAL_FILE_MUTATION') {
    throw new Error('Gate nao executado: defina OVERCORE_RUN_OMNI_EFFECT_E2E=I_UNDERSTAND_LOCAL_FILE_MUTATION.')
  }
  const repository = process.env.OVERCORE_OMNI_REPOSITORY_PATH
  if (!repository) throw new Error('OVERCORE_OMNI_REPOSITORY_PATH nao foi definida.')
  const token = randomBytes(32).toString('hex')
  const omni = await startOmni(repository, token)
  const directory = await mkdtemp(join(tmpdir(), 'overcore-omni-effect-'))
  try {
    const target = join(directory, 'alvo.txt')
    await writeFile(target, 'antes\n', 'utf8')
    const now = new Date()
    const base = {
      contractVersion: '1.0',
      authorizationRequestId: 'authreq-omni-effect-live-0001',
      createdAt: now.toISOString(),
      requester: { id: 'overcore-execution-environment', kind: 'execution-environment' },
      authorityProvider: { id: 'omni-authority-provider', kind: 'assistant' },
      requestBinding: {
        requestId: 'request-omni-effect-live-0001',
        requestFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'1'.repeat(64)}` },
        clientId: 'client-omni-effect-live-0001'
      },
      planBinding: {
        planId: 'plan-omni-effect-live-0001', planRevision: 1,
        planFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'2'.repeat(64)}` },
        strategyFingerprint: { algorithm: 'sha256-jcs-v1', value: `sha256:${'3'.repeat(64)}` }
      },
      authorityCeiling: {
        mode: 'proceed-within-scope',
        grants: [{ resourceRef: 'resource-omni-effect-live-file', operations: ['filesystem.modify'] }],
        expansionBoundaries: []
      },
      actions: [{
        actionId: 'action-omni-effect-live-0001', stepRef: 'step-omni-effect-live-0001', position: 1,
        scope: 'request-resource', resourceRef: 'resource-omni-effect-live-file', operation: 'filesystem.modify',
        effectMode: 'journaled', effectKey: 'task-omni-effect-live-0001/change-file',
        effectClass: 'reversible-change', riskLevel: 'medium',
        requestedControls: [
          'checkpoint-before-mutation', 'verify-after-effect',
          'reconcile-before-retry', 'revocation-check-before-effect'
        ]
      }],
      riskSummary: {
        maximumRisk: 'medium', triggeredBoundaries: [], requestResourceActionCount: 1, journaledEffectCount: 1
      }
    }
    const authorizationRequest = { ...base, authorizationRequestFingerprint: fingerprint(base) }
    const revalidation = new URL(omni.endpoint)
    revalidation.pathname = '/v1/authority/revalidate-effect'
    const result = await new FileEffectHarness(
      new InMemoryEffectJournalStore(),
      new FileCheckpointStore(join(directory, 'checkpoints')),
      new HttpEffectAuthorityGuard(revalidation, token)
    ).apply({
      taskId: 'task-omni-effect-live-0001',
      effectKey: 'task-omni-effect-live-0001/change-file',
      resourceRef: 'resource-omni-effect-live-file',
      targetUri: pathToFileURL(target).href,
      desiredContent: 'depois\n',
      authorization: {
        enforcementId: 'authenf-omni-effect-live-0001',
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        operations: ['filesystem.modify'],
        requiredControls: [
          'checkpoint-before-mutation', 'verify-after-effect',
          'reconcile-before-retry', 'revocation-check-before-effect'
        ],
        authorizationRequest,
        actionId: 'action-omni-effect-live-0001'
      }
    })
    assert.equal(result.wrote, true)
    assert.ok(result.authorizationEvidence)
    assert.equal(await readFile(target, 'utf8'), 'depois\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
    await stop(omni.process)
  }
})
