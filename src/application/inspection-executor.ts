import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sha256 } from '../domain/fingerprint.js'
import type { InspectionEvidence, JsonObject } from '../domain/types.js'
import type { AgentRuntimePort } from '../ports/agent-runtime.js'
import type { ExecutionControl } from '../ports/execution-control.js'
import { ExecutionFailure, type InspectionExecutor } from '../ports/task-store.js'

function runtimeFailure(error: unknown): ExecutionFailure {
  if (error instanceof ExecutionFailure) return error
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'AnthropicLoginRequiredError') {
    return new ExecutionFailure('agent-runtime-login-required', 'external', false, message)
  }
  if (/abort|timeout|tempo .*esgotado|rate.limit|overload|ECONN|network|socket/i.test(`${name}:${message}`)) {
    return new ExecutionFailure('agent-runtime-transient', 'transient', true, message, 5_000)
  }
  return new ExecutionFailure('agent-runtime-interrupted', 'internal', true, message, 5_000)
}

export class ReadOnlyContractInspectionExecutor implements InspectionExecutor {
  async execute(input: Parameters<InspectionExecutor['execute']>[0], control?: ExecutionControl): Promise<JsonObject> {
    await control?.assertActive()
    const { repositoryUri } = input
    if (!repositoryUri.startsWith('file:')) throw new Error('Executor de inspeção aceita somente file://.')
    const contracts = join(fileURLToPath(repositoryUri), 'contratos')
    const names = (await readdir(contracts)).filter((name) => name.endsWith('.schema.json')).sort()
    const files: InspectionEvidence['files'] = []
    for (const name of names) {
      control?.signal.throwIfAborted()
      const raw = await readFile(join(contracts, name), 'utf8')
      let parsed: unknown
      let readable = true
      try {
        parsed = JSON.parse(raw)
      } catch {
        readable = false
      }
      const rootClosed = readable && Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>).additionalProperties === false
      files.push({ name, readable, rootClosed, digest: sha256(raw) })
    }
    const evidence: InspectionEvidence = {
      repositoryUri,
      schemaCount: files.length,
      files,
      capturedAt: new Date().toISOString()
    }
    return evidence as unknown as JsonObject
  }
}

export class AgentAssistedContractInspectionExecutor implements InspectionExecutor {
  constructor(
    private readonly runtime: AgentRuntimePort,
    private readonly deterministic = new ReadOnlyContractInspectionExecutor()
  ) {}

  async execute(input: Parameters<InspectionExecutor['execute']>[0], control?: ExecutionControl): Promise<JsonObject> {
    await control?.assertActive()
    const root = fileURLToPath(input.repositoryUri)
    const prevalidated = input.strategyRevision > 1
      ? await this.deterministic.execute(input, control) as unknown as InspectionEvidence
      : undefined
    let result
    try {
      result = await this.runtime.run({
      purpose: 'execution',
      runId: input.runId,
      cwd: root,
      objective: [
        input.objective,
        `Esta e a estrategia ${input.strategyRevision}; em retry, confirme o snapshot prevalidado antes da analise.`,
        'Inspecione somente os arquivos *.schema.json da pasta contratos.',
        'Não modifique arquivos. Devolva um relatório curto com os arquivos encontrados e qualquer divergência.'
      ].join('\n'),
      instructions: [
        'Você é o motor de inspeção do Overcore para esta execução.',
        'A autorização já foi decidida pelo Omni e permite apenas leitura.',
        'Use somente Read, Glob e Grep. Não proponha nem execute alterações.'
      ].join('\n'),
      tools: ['Read', 'Glob', 'Grep'],
      maxTurns: Math.min(5 + input.strategyRevision, 20),
      timeoutMs: input.timeoutMs,
      authorization: input.authorization,
      ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd })
      }, undefined, control?.signal)
    } catch (error) {
      throw runtimeFailure(error)
    }
    const inspection = prevalidated
      ?? await this.deterministic.execute(input, control) as unknown as InspectionEvidence
    inspection.agentRuntime = {
      engine: result.engine,
      sdkVersion: result.sdkVersion,
      authSource: result.authSource,
      sessionId: result.sessionId,
      model: result.model,
      report: result.output,
      outputDigest: sha256(result.output),
      durationMs: result.durationMs,
      turns: result.turns,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
      estimatedCostUsd: result.usage.estimatedCostUsd,
      permissionDenials: result.permissionDenials,
      eventCount: result.events.length
    }
    return inspection as unknown as JsonObject
  }
}
