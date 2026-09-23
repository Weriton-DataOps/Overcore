import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { AdaptiveDiscovery } from '../src/application/adaptive-discovery.js'
import { BaselineDiscovery } from '../src/application/baseline-discovery.js'
import { TaskPreflight } from '../src/application/task-preflight.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { fingerprint } from '../src/domain/fingerprint.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { discoveryQualityCases, qualityDraft } from '../integration/discovery-quality-cases.js'
import { ClaudeDiscoveryAdvisor } from '../src/infrastructure/discovery/claude-discovery-advisor.js'
import type { TaskDraft } from '../src/domain/types.js'
import type { AgentRuntimePort, AgentRuntimeRequest, AgentRuntimeResult } from '../src/ports/agent-runtime.js'
import type { DiscoveryAssessment, DiscoveryPort, DiscoveryRequest } from '../src/ports/discovery.js'

const root = process.cwd()

async function request(): Promise<DiscoveryRequest> {
  const draft = JSON.parse(await readFile(join(root, 'contratos', 'exemplos', 'task-draft-resolvido.json'), 'utf8')) as TaskDraft
  return {
    draft,
    profile: { depth: 'standard', reason: 'O pedido possui contexto e critÃ©rios suficientes para leitura preparatÃ³ria.' },
    generatedAt: '2026-09-18T12:00:00.000Z',
    appliedDecisions: []
  }
}

class FakeRuntime implements AgentRuntimePort {
  received?: AgentRuntimeRequest
  output?: string
  async run(input: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    this.received = input
    return {
      engine: 'anthropic-claude-agent-sdk', sdkVersion: 'test', authSource: 'oauth-login',
      sessionId: 'session-discovery-test-0001', model: 'claude-test', durationMs: 5, turns: 1,
      output: this.output ?? JSON.stringify({
        summary: 'Falta escolher o formato que prova a compatibilidade.',
        questions: [{
          topic: 'compatibility',
          question: 'Qual consumidor existente precisa continuar compatÃ­vel?',
          reason: 'A resposta muda a forma da entrega e seu critÃ©rio de aceitaÃ§Ã£o.'
        }]
      }),
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0 },
      permissionDenials: 0, events: []
    }
  }
}

test('assessor Claude recebe o TaskDraft serializado e nenhuma ferramenta', async () => {
  const runtime = new FakeRuntime()
  const advisor = new ClaudeDiscoveryAdvisor(runtime, root)
  const advice = await advisor.advise(await request())
  assert.equal(advice.questions.length, 1)
  assert.equal(runtime.received?.purpose, 'discovery')
  assert.deepEqual(runtime.received?.tools, [])
  assert.deepEqual(runtime.received?.authorization.operations, ['discovery.analyze'])
  assert.match(runtime.received?.objective ?? '', /TaskDraft:/)
})

test('Discovery adaptativa converte lacuna material em decisão inclusive para pedido curto', async () => {
  let advisorCalls = 0
  const baseline: DiscoveryPort = {
    async inspect(): Promise<DiscoveryAssessment> {
      return {
        readinessChecks: [{ checkId: 'criteria-testable', status: 'passed', summary: 'CritÃ©rio inicial presente.', evidenceRefs: [], decisionRefs: [] }],
        automaticDecisions: [], requiredDecisions: [], evidence: []
      }
    }
  }
  const advisor = {
    async advise() {
      advisorCalls += 1
      return {
        summary: 'A compatibilidade ainda precisa de escolha explÃ­cita.',
        questions: [{ topic: 'compatibility' as const, question: 'Qual formato manter?', reason: 'A escolha muda o contrato entregue.' }],
        provenance: { engine: 'anthropic-claude-agent-sdk' as const, model: 'claude-test', sessionId: 'session-test', outputDigest: 'sha256:test', turns: 1 }
      }
    }
  }
  const adaptive = new AdaptiveDiscovery(baseline, advisor)
  const standard = await adaptive.inspect(await request())
  assert.equal(advisorCalls, 1)
  assert.equal(standard.requiredDecisions.length, 1)
  assert.equal(standard.readinessChecks[0]?.status, 'needs-decision')

  const light = await request()
  light.profile = { depth: 'light', reason: 'Pedido simples.' }
  await adaptive.inspect(light)
  assert.equal(advisorCalls, 2)
})

function evalRequest(id: string): DiscoveryRequest {
  const item = discoveryQualityCases.find((item) => item.id === id)!
  const now = new Date().toISOString()
  return { draft: qualityDraft(item, now), generatedAt: now, profile: { depth: 'light', reason: 'Poucos campos.' }, appliedDecisions: [] }
}

test('pedido curto ambíguo chega ao assessor pelo Preflight real, sem liberar tarefa', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const runtime = new FakeRuntime()
  runtime.output = JSON.stringify({ summary: 'O resultado pretendido ainda está aberto.', questions: [{ topic: 'scope', question: 'Qual melhoria deseja no relatório?', reason: 'Muda o trabalho a realizar.' }] })
  const preflight = new TaskPreflight(validator, new AdaptiveDiscovery(new BaselineDiscovery(), new ClaudeDiscoveryAdvisor(runtime, root)), new InMemoryTaskStore())
  const report = await preflight.run(evalRequest('short-ambiguous').draft)
  assert.equal(report.status, 'decisions-required')
  assert.equal(report.requiredDecisions.length, 1)
  assert.equal(report.preparedRequest, undefined)
  assert.ok(runtime.received)
})

test('decisões validadas de revisão anterior e pending chegam ao assessor sem carregar o relatório inteiro', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const runtime = new FakeRuntime()
  runtime.output = JSON.stringify({ summary: 'As decisões pendentes já foram mapeadas pelas regras locais.', questions: [] })
  const preflight = new TaskPreflight(validator, new AdaptiveDiscovery(new BaselineDiscovery(), new ClaudeDiscoveryAdvisor(runtime, root)), new InMemoryTaskStore())
  const first = evalRequest('baseline-question').draft
  const report = await preflight.run(first)
  assert.equal(report.status, 'decisions-required')
  assert.match(runtime.received!.objective, /Como o sucesso desta tarefa será comprovado/)
  const decision = report.requiredDecisions[0]!
  const second = structuredClone(first)
  second.revision = 2
  second.knownAcceptanceCriteria = [{ id: 'criterion-summary', description: 'Inspecionar até cinco bullets com números iguais aos do relatório, preservando o restante.', verificationHint: 'inspection' }]
  second.decisionAnswers = [{
    answerId: 'answer-quality-proof', decisionId: decision.decisionId,
    sourceReport: { reportId: report.reportId, draftRevision: report.draftRevision, draftFingerprint: report.draftFingerprint, reportFingerprint: fingerprint(report) },
    selectedOptionId: decision.recommendedOptionId, answeredAt: new Date().toISOString(), answeredBy: 'owner-evaluation'
  }]
  const resolved = await preflight.run(second)
  assert.equal(resolved.status, 'ready')
  assert.equal(resolved.appliedDecisionAnswers.length, 1)
  assert.match(runtime.received!.objective, /Definir prova objetiva/)
  assert.doesNotMatch(runtime.received!.objective, /"readinessChecks"/)
  assert.match(runtime.received!.objective, /"pending":\[\]/)
  assert.match(runtime.received!.objective, /A resposta substantiva está nos campos da revisão atual/)
  assert.match(runtime.received!.objective, /não pergunte novamente sobre análise entre contratos/)
})

test('duplicata literal é consolidada, mas perguntas distintas do mesmo tópico continuam visíveis', async () => {
  const baseline = new BaselineDiscovery()
  const req = evalRequest('baseline-question')
  const pending = (await baseline.inspect(req)).requiredDecisions[0]!
  const runtime = new FakeRuntime()
  runtime.output = JSON.stringify({ summary: 'Duas escolhas de comportamento além do critério de aceite.', questions: [
    { topic: 'behavior', question: String(pending.question).toLocaleUpperCase('pt-BR'), reason: 'Pergunta já existente.' },
    { topic: 'behavior', question: 'Como tratar valores negativos?', reason: 'Escolha material distinta.' },
    { topic: 'behavior', question: 'Como tratar mês sem receita?', reason: 'Outra escolha material distinta.' }
  ] })
  const report = await new AdaptiveDiscovery(baseline, new ClaudeDiscoveryAdvisor(runtime, root)).inspect(req)
  assert.equal(report.requiredDecisions.length, 3)
  assert.equal(report.requiredDecisions.filter((d) => String(d.question).toLocaleLowerCase('pt-BR') === String(pending.question).toLocaleLowerCase('pt-BR')).length, 1)
})

test('modo baseline não chama modelo; falha comprovada também não dispara assessor', async () => {
  const req = evalRequest('complete-inspection')
  const baseline = new BaselineDiscovery()
  assert.equal((await new AdaptiveDiscovery(baseline).inspect(req)).requiredDecisions.length, 0)
  let calls = 0
  const failed: DiscoveryPort = { async inspect() { return { readinessChecks: [], automaticDecisions: [], requiredDecisions: [], evidence: [], failure: { code: 'fixture-failure' } } } }
  const advisor = { async advise(): Promise<never> { calls++; throw new Error('Não chamar após impossibilidade comprovada.') } }
  const result = await new AdaptiveDiscovery(failed, advisor).inspect(req)
  assert.equal(calls, 0)
  assert.equal(result.failure?.code, 'fixture-failure')
})

test('JSON inválido mantém as decisões determinísticas e registra indisponibilidade explícita', async () => {
  const runtime = new FakeRuntime()
  runtime.output = 'não é JSON'
  const assessment = await new AdaptiveDiscovery(new BaselineDiscovery(), new ClaudeDiscoveryAdvisor(runtime, root)).inspect(evalRequest('baseline-question'))
  assert.equal(assessment.requiredDecisions.length, 1)
  assert.ok(assessment.evidence.some((item) => String(item.summary).startsWith('Discovery assistida indisponível;')))
})
