import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sha256 } from '../domain/fingerprint.js'
import type { InspectionEvidence, JsonObject } from '../domain/types.js'
import type { AgentRuntimePort } from '../ports/agent-runtime.js'
import type { InspectionExecutor } from '../ports/task-store.js'

export class ReadOnlyContractInspectionExecutor implements InspectionExecutor {
  async execute(input: Parameters<InspectionExecutor['execute']>[0]): Promise<JsonObject> {
    const { repositoryUri } = input
    if (!repositoryUri.startsWith('file:')) throw new Error('Executor de inspeção aceita somente file://.')
    const contracts = join(fileURLToPath(repositoryUri), 'contratos')
    const names = (await readdir(contracts)).filter((name) => name.endsWith('.schema.json')).sort()
    const files: InspectionEvidence['files'] = []
    for (const name of names) {
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

  async execute(input: Parameters<InspectionExecutor['execute']>[0]): Promise<JsonObject> {
    const root = fileURLToPath(input.repositoryUri)
    const result = await this.runtime.run({
      runId: input.runId,
      cwd: root,
      objective: [
        input.objective,
        'Inspecione somente os arquivos *.schema.json da pasta contratos.',
        'Não modifique arquivos. Devolva um relatório curto com os arquivos encontrados e qualquer divergência.'
      ].join('\n'),
      instructions: [
        'Você é o motor de inspeção do Overcore para esta execução.',
        'A autorização já foi decidida pelo Omni e permite apenas leitura.',
        'Use somente Read, Glob e Grep. Não proponha nem execute alterações.'
      ].join('\n'),
      tools: ['Read', 'Glob', 'Grep'],
      maxTurns: 6,
      timeoutMs: input.timeoutMs,
      authorization: input.authorization,
      ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd })
    })
    const inspection = await this.deterministic.execute(input) as unknown as InspectionEvidence
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
