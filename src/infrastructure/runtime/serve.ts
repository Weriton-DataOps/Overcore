import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AdaptiveDiscovery } from '../../application/adaptive-discovery.js'
import { BaselineDiscovery } from '../../application/baseline-discovery.js'
import { FileEffectHarness } from '../../application/file-effect-harness.js'
import { HarnessFileReplacementExecutor } from '../../application/file-replacement-executor.js'
import { AgentAssistedContractInspectionExecutor } from '../../application/inspection-executor.js'
import { RepositoryChangeWorkbench } from '../../application/repository-change-executor.js'
import { TaskManager } from '../../application/task-manager.js'
import { TaskPreflight } from '../../application/task-preflight.js'
import { TaskWorker } from '../../application/task-worker.js'
import { ContractValidator } from '../../contracts/validator.js'
import { AnthropicAgentSdkRuntime } from '../agent-runtime/anthropic-agent-sdk.js'
import { ClaudeRepositoryEditor } from '../agent-runtime/claude-repository-editor.js'
import { HttpAuthorityProvider } from '../authority/http-authority-provider.js'
import { HttpEffectAuthorityGuard } from '../authority/http-effect-authority-guard.js'
import { FileCheckpointStore } from '../checkpoints/file-checkpoint-store.js'
import { ClaudeDiscoveryAdvisor } from '../discovery/claude-discovery-advisor.js'
import { createLocalServer } from '../http/local-server.js'
import { loadRuntimeConfig } from './config.js'
import { removeRuntimeDescriptor, writeRuntimeDescriptor } from './descriptor.js'
import { abrirPersistencia, type OpcoesDePersistencia } from './persistencia.js'
import { readValidationEvidence } from './validation-evidence.js'

export interface OpcoesDeSubida {
  env?: NodeJS.ProcessEnv
  migracoes?: OpcoesDePersistencia['migracoes']
  /** Falso na casa do Omni: toda rota exige token, inclusive o /health. */
  healthAberto?: boolean
  /** Outro processo assumiu o banco SQLite; quem subiu decide como parar. */
  aoPerderPosse: (error: Error) => void
  /** Linhas de diagnóstico do reconciliador e do worker; nunca o stdout, que pertence a quem subiu. */
  log?: (texto: string) => void
}

export interface Subida {
  host: string
  porta: number
  motor: 'postgres' | 'sqlite'
  /** Idempotente: para os laços, fecha o servidor, apaga o descritor e solta o banco. */
  encerrar(): Promise<void>
}

const versaoDe = (projectRoot: string): string =>
  (JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { version: string }).version

/**
 * Sobe o runtime local (motor, servidor HTTP, reconciliador e worker) sem escrever no stdout nem tratar
 * sinais: isso é de quem chama, o `serve` legado ou o `servir` da casa do Omni. Se algo falhar depois
 * do banco aberto, a posse é solta antes do erro subir.
 */
export async function subir(projectRoot: string, opcoes: OpcoesDeSubida): Promise<Subida> {
  const log = opcoes.log ?? ((texto: string) => { process.stderr.write(`${texto}\n`) })
  const config = loadRuntimeConfig(opcoes.env ?? process.env)
  const persistencia = await abrirPersistencia(config.database, projectRoot, {
    aoPerderPosse: (error) => opcoes.aoPerderPosse(error),
    ...(opcoes.migracoes ? { migracoes: opcoes.migracoes } : {})
  })
  let encerrar: (() => Promise<void>) | undefined
  try {
    const { store, effectJournal } = persistencia
    const validator = await ContractValidator.create(projectRoot)
    const authority = new HttpAuthorityProvider(config.authorityProviderUrl, config.authorityProviderToken)
    const discovery = config.discoveryMode === 'advisor'
      ? new AdaptiveDiscovery(
          new BaselineDiscovery(),
          new ClaudeDiscoveryAdvisor(new AnthropicAgentSdkRuntime(), projectRoot)
        )
      : new AdaptiveDiscovery(new BaselineDiscovery())
    const manager = new TaskManager(store, validator, authority, undefined, new TaskPreflight(validator, discovery, store))
    const effectAuthority = new HttpEffectAuthorityGuard(
      new URL('/v1/authority/revalidate-effect', config.authorityProviderUrl),
      config.authorityProviderToken
    )
    const inspectionExecutor = new AgentAssistedContractInspectionExecutor(new AnthropicAgentSdkRuntime())
    const fileReplacementExecutor = new HarnessFileReplacementExecutor(new FileEffectHarness(
      effectJournal,
      new FileCheckpointStore(join(config.runtimeDirectory, 'checkpoints')),
      effectAuthority
    ))
    const postgresProbeExecutor = persistencia.sondaPostgres?.(effectJournal, effectAuthority)
    // Cada tarefa ganha sua própria worktree sob esta raiz; a bancada não guarda estado entre tarefas.
    const repositoryChangeExecutor = new RepositoryChangeWorkbench(new ClaudeRepositoryEditor(), {
      worktreeRoot: join(config.runtimeDirectory, 'worktrees')
    })
    const workers = Array.from({ length: config.workerSlots }, (_, slot) => new TaskWorker(
      `worker-${process.pid}-${slot + 1}`,
      store,
      validator,
      inspectionExecutor,
      undefined,
      fileReplacementExecutor,
      postgresProbeExecutor,
      repositoryChangeExecutor
    ))
    const [worker] = workers
    if (!worker) throw new Error('OVERCORE_WORKER_SLOTS não criou nenhum worker.')
    const server = createLocalServer(manager, worker, config.localToken, [
      'inspection-report-sha256-v1',
      'inspection-independent-semantic-review-v1',
      'inspection-direct-entries-snapshot-and-tool-telemetry-v1',
      'repository-change-worktree-v1',
      'execution-read-view-v1'
    ], () => readValidationEvidence(projectRoot), {
      openHealth: opcoes.healthAberto ?? true,
      health: { agente: 'overcore', versao: versaoDe(projectRoot), motor: persistencia.motor }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, resolve)
    })
    const fecharServidor = () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    encerrar = async () => {
      await fecharServidor()
      await persistencia.encerrar()
    }
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Servidor local não informou porta TCP.')
    const descriptorPath = await writeRuntimeDescriptor(config.runtimeDirectory, {
      schemaVersion: 1,
      pid: process.pid,
      host: config.host,
      port: address.port,
      startedAt: new Date().toISOString()
    })

    let reconciling = false
    const reconcile = () => {
      if (reconciling) return
      reconciling = true
      void manager.reconcilePending()
        .then((outcomes) => {
          for (const outcome of outcomes) {
            if (outcome.outcome === 'failed') {
              log(`reconciler ${outcome.taskId}: ${outcome.error ?? 'falha sem mensagem'}`)
            } else if (outcome.outcome === 'deferred') {
              log(`reconciler ${outcome.taskId}: ${outcome.error ?? 'nova tentativa adiada'}; retry ${outcome.retryAt ?? 'não informado'}`)
            }
          }
        })
        .catch((error: unknown) => log(`reconciler: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { reconciling = false })
    }
    reconcile()
    const reconciliationInterval = setInterval(reconcile, 1_000)
    reconciliationInterval.unref()

    // Um slot ocupado não segura os outros: execuções correm lado a lado, cada uma com seu lease na
    // outbox e sua worktree. No SQLite, a cerca é o mutex da tarefa dentro deste processo (ADR-023 D3).
    const busy = workers.map(() => false)
    const workerInterval = setInterval(() => {
      workers.forEach((slotWorker, slot) => {
        if (busy[slot]) return
        busy[slot] = true
        void slotWorker.runOnce()
          .catch((error: unknown) => log(`worker ${slot + 1}: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => { busy[slot] = false })
      })
    }, 500)
    workerInterval.unref()

    let closing: Promise<void> | undefined
    return {
      host: config.host,
      porta: address.port,
      motor: persistencia.motor,
      encerrar() {
        closing ??= (async () => {
          clearInterval(reconciliationInterval)
          clearInterval(workerInterval)
          await fecharServidor()
          await removeRuntimeDescriptor(descriptorPath)
          await persistencia.encerrar()
        })()
        return closing
      }
    }
  } catch (error) {
    await (encerrar ?? (() => persistencia.encerrar()))().catch(() => {})
    throw error
  }
}

/**
 * O serve legado: sobe pelo env do processo, anuncia o endereço no stdout e encerra por SIGINT, SIGTERM
 * ou quando o processo pai (supervisor com canal IPC) se desconecta, soltando o banco e o descritor.
 */
export async function serve(projectRoot: string): Promise<void> {
  let shutdown: (exitCode: number) => void = (exitCode) => { process.exit(exitCode) }
  const rodando = await subir(projectRoot, {
    aoPerderPosse: (error) => {
      process.stderr.write(`${error.message}\n`)
      shutdown(1)
    }
  })
  process.stdout.write(`Overcore ativo em http://${rodando.host}:${rodando.porta}\n`)
  shutdown = (exitCode) => {
    void rodando.encerrar()
      .catch((error: unknown) => process.stderr.write(`shutdown: ${error instanceof Error ? error.message : String(error)}\n`))
      .finally(() => process.exit(exitCode))
  }
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))
  // No Windows o pai não consegue mandar SIGTERM tratável; o supervisor desliga fechando o canal IPC.
  if (process.connected) process.once('disconnect', () => shutdown(0))
}
