import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

import { AdaptiveDiscovery } from '../src/application/adaptive-discovery.js'
import { BaselineDiscovery } from '../src/application/baseline-discovery.js'
import { TaskPreflight } from '../src/application/task-preflight.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { fingerprint } from '../src/domain/fingerprint.js'
import { AnthropicAgentSdkRuntime } from '../src/infrastructure/agent-runtime/anthropic-agent-sdk.js'
import { ClaudeDiscoveryAdvisor } from '../src/infrastructure/discovery/claude-discovery-advisor.js'
import type { AgentRuntimePort, AgentRuntimeResult } from '../src/ports/agent-runtime.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { discoveryQualityCases, qualityDraft, scoreQuestions } from './discovery-quality-cases.js'

// Deliberately outside npm test: live OAuth quota is used only with --live.
const args = process.argv.slice(2)
const flags = args.filter((arg) => arg.startsWith('--'))
if (flags.length !== 1 || !['--live', '--dry-run'].includes(flags[0]!)) throw new Error('Informe exatamente um modo: --dry-run ou --live.')
const live = args.includes('--live')
const selected = args.filter((arg) => !arg.startsWith('--'))
if (selected.some((id) => !discoveryQualityCases.some((item) => item.id === id))) throw new Error('Caso de avaliação desconhecido.')
const cases = discoveryQualityCases.filter((item) => selected.length === 0 || selected.includes(item.id))
const root = process.cwd()
const runStartedAt = new Date().toISOString()
const validator: ContractValidator = await ContractValidator.create(root)
const runtime = new AnthropicAgentSdkRuntime((input) => query({
  ...input, options: { ...input.options, persistSession: false }
}))
const results: Array<Record<string, unknown>> = []
let sdkEstimatedCostUsd = 0

for (const item of cases) {
  const draft = qualityDraft(item, new Date().toISOString())
  validator.taskDraft(draft)
  if (!live) {
    results.push({ id: item.id, contractValid: true, review: item.review })
    continue
  }
  const calls: AgentRuntimeResult[] = []
  let attempted = 0
  const recording: AgentRuntimePort = {
    async run(request, sink, signal) {
      attempted += 1
      const result = await runtime.run({ ...request, maxCostUsd: 0.35 }, sink, signal)
      calls.push(result)
      sdkEstimatedCostUsd += result.usage.estimatedCostUsd
      return result
    }
  }
  const started = Date.now()
  try {
    const preflight = new TaskPreflight(validator,
      new AdaptiveDiscovery(new BaselineDiscovery(), new ClaudeDiscoveryAdvisor(recording, root)), new InMemoryTaskStore())
    const report = await preflight.run(draft)
    const questions = report.requiredDecisions.map((item) => ({ topic: String(item.topic), question: String(item.question), reason: String(item.reason) }))
    const failures = scoreQuestions(item, questions)
    if (calls.length !== 1) failures.push(`O assessor não concluiu uma chamada real: ${attempted} tentativa(s), ${calls.length} resultado(s).`)
    if (calls.some((call) => call.permissionDenials > 0 || call.events.some((event) => event.type === 'tool-requested'))) failures.push('O assessor tentou usar ferramenta.')
    results.push({ id: item.id, draftFingerprint: fingerprint(draft), status: report.status, questions, failures,
      review: item.review, durationMs: Date.now() - started,
      runtime: calls.map((call) => ({ model: call.model, authSource: call.authSource, sdkVersion: call.sdkVersion, turns: call.turns, usage: call.usage,
        permissionDenials: call.permissionDenials, toolRequests: call.events.filter((event) => event.type === 'tool-requested').length })),
      fallback: report.evidence.filter((evidence) => String(evidence.summary).startsWith('Discovery assistida indisponível;')).map((evidence) => evidence.summary)
    })
    console.log(`${item.id}: ${failures.length ? 'FAIL' : 'PASS'}; ${questions.length} pergunta(s); ${Date.now() - started} ms`)
  } catch (error) {
    results.push({ id: item.id, failures: [error instanceof Error ? error.message : String(error)], durationMs: Date.now() - started })
    console.log(`${item.id}: ERROR`)
  }
  // Per-call cap also applies. Stop the batch on authentication/runtime failure;
  // repeatedly starting a broken login does not evaluate quality.
  if (attempted > 0 && calls.length === 0) break
  if (sdkEstimatedCostUsd >= 2.5) break
}

const failed = results.filter((result) => Array.isArray(result.failures) && result.failures.length > 0).length
const report = {
  formatVersion: 1, suiteVersion: 3, runStartedAt, generatedAt: new Date().toISOString(), live, casesRequested: cases.length,
  casesCompleted: results.length, failed, sdkEstimatedCostUsd,
  note: 'Casos sintéticos representativos, chamadas reais via OAuth. Pontuação mecânica não substitui revisão semântica. Estimativa do SDK não é uma cobrança adicional comprovada. Nenhum arquivo de projeto foi enviado ou executado.',
  results
}
const directory = resolve(root, '.overcore-runtime', 'evaluations', 'discovery')
await mkdir(directory, { recursive: true })
const path = join(directory, `${live ? 'live' : 'dry'}-${Date.now()}.json`)
await writeFile(path, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
console.log(`Relatório: ${path}`)
console.log(`Casos: ${results.length}/${cases.length}; falhas: ${failed}; SDK estimate USD: ${sdkEstimatedCostUsd.toFixed(4)}`)
if (failed > 0 || results.length !== cases.length) process.exitCode = 1
