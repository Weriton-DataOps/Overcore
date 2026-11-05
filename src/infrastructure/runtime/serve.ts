import { join } from 'node:path'

import { AdaptiveDiscovery } from '../../application/adaptive-discovery.js'
import { BaselineDiscovery } from '../../application/baseline-discovery.js'
import { FileEffectHarness } from '../../application/file-effect-harness.js'
import { HarnessFileReplacementExecutor } from '../../application/file-replacement-executor.js'
import { AgentAssistedContractInspectionExecutor } from '../../application/inspection-executor.js'
import { TaskManager } from '../../application/task-manager.js'
import { TaskPreflight } from '../../application/task-preflight.js'
import { TaskWorker } from '../../application/task-worker.js'
import { ContractValidator } from '../../contracts/validator.js'
import { AnthropicAgentSdkRuntime } from '../agent-runtime/anthropic-agent-sdk.js'
import { HttpAuthorityProvider } from '../authority/http-authority-provider.js'
import { HttpEffectAuthorityGuard } from '../authority/http-effect-authority-guard.js'
import { FileCheckpointStore } from '../checkpoints/file-checkpoint-store.js'
import { ClaudeDiscoveryAdvisor } from '../discovery/claude-discovery-advisor.js'
import { createLocalServer } from '../http/local-server.js'
import { loadRuntimeConfig } from './config.js'
import { removeRuntimeDescriptor, writeRuntimeDescriptor } from './descriptor.js'
import { abrirPersistencia } from './persistencia.js'
import { readValidationEvidence } from './validation-evidence.js'

/**
 * Sobe o runtime local: motor escolhido por OVERCORE_DATABASE_ENGINE, servidor HTTP,
 * reconciliador e worker. Encerra por SIGINT, SIGTERM ou quando o processo pai
 * (supervisor com canal IPC) se desconecta, soltando o banco e o descritor.
 */
export async function serve(projectRoot: string): Promise<void> {
  const config = loadRuntimeConfig()
  let shutdown: (exitCode: number) => void = (exitCode) => { process.exit(exitCode) }
  const persistencia = await abrirPersistencia(config.database, projectRoot, {
    aoPerderPosse: (error) => {
      process.stderr.write(`${error.message}\n`)
      shutdown(1)
    }
  })
  const { store, effectJournal } = persistencia
  const validator = await ContractValidator.create(projectRoot)
  const authority = new HttpAuthorityProvider(
    config.authorityProviderUrl,
    config.authorityProviderToken
  )
  const discovery = config.discoveryMode === 'advisor'
    ? new AdaptiveDiscovery(
        new BaselineDiscovery(),
        new ClaudeDiscoveryAdvisor(new AnthropicAgentSdkRuntime(), projectRoot)
      )
    : new AdaptiveDiscovery(new BaselineDiscovery())
  const manager = new TaskManager(
    store,
    validator,
    authority,
    undefined,
    new TaskPreflight(validator, discovery, store)
  )
  const effectAuthority = new HttpEffectAuthorityGuard(
    new URL('/v1/authority/revalidate-effect', config.authorityProviderUrl),
    config.authorityProviderToken
  )
  const worker = new TaskWorker(
    `worker-${process.pid}`,
    store,
    validator,
    new AgentAssistedContractInspectionExecutor(new AnthropicAgentSdkRuntime()),
    undefined,
    new HarnessFileReplacementExecutor(new FileEffectHarness(
      effectJournal,
      new FileCheckpointStore(join(config.runtimeDirectory, 'checkpoints')),
      effectAuthority
    )),
    persistencia.sondaPostgres?.(effectJournal, effectAuthority)
  )
  const server = createLocalServer(manager, worker, config.localToken, [
    'inspection-report-sha256-v1',
    'inspection-independent-semantic-review-v1',
    'inspection-direct-entries-snapshot-and-tool-telemetry-v1'
  ], () => readValidationEvidence(projectRoot))
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

  let reconciling = false
  const reconcile = () => {
    if (reconciling) return
    reconciling = true
    void manager.reconcilePending()
      .then((outcomes) => {
        for (const outcome of outcomes) {
          if (outcome.outcome === 'failed') {
            process.stderr.write(`reconciler ${outcome.taskId}: ${outcome.error ?? 'falha sem mensagem'}\n`)
          } else if (outcome.outcome === 'deferred') {
            process.stderr.write(
              `reconciler ${outcome.taskId}: ${outcome.error ?? 'nova tentativa adiada'}; retry ${outcome.retryAt ?? 'não informado'}\n`
            )
          }
        }
      })
      .catch((error: unknown) => process.stderr.write(
        `reconciler: ${error instanceof Error ? error.message : String(error)}\n`
      ))
      .finally(() => { reconciling = false })
  }
  reconcile()
  const reconciliationInterval = setInterval(reconcile, 1_000)
  reconciliationInterval.unref()

  let working = false
  const workerInterval = setInterval(() => {
    if (working) return
    working = true
    void worker.runOnce()
      .catch((error: unknown) => process.stderr.write(`worker: ${error instanceof Error ? error.message : String(error)}\n`))
      .finally(() => { working = false })
  }, 500)
  workerInterval.unref()

  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      clearInterval(reconciliationInterval)
      clearInterval(workerInterval)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await removeRuntimeDescriptor(descriptorPath)
      await persistencia.encerrar()
    })()
    return closing
  }
  shutdown = (exitCode) => {
    void close()
      .catch((error: unknown) => process.stderr.write(`shutdown: ${error instanceof Error ? error.message : String(error)}\n`))
      .finally(() => process.exit(exitCode))
  }
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))
  // No Windows o pai não consegue mandar SIGTERM tratável; o supervisor desliga fechando o canal IPC.
  if (process.connected) process.once('disconnect', () => shutdown(0))
}
