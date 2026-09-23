import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import { AgentAssistedContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ContractValidator } from '../src/contracts/validator.js'
import type { TaskRequest } from '../src/domain/types.js'
import {
  AnthropicAgentSdkRuntime,
  AnthropicLoginRequiredError
} from '../src/infrastructure/agent-runtime/anthropic-agent-sdk.js'
import type { AgentRuntimePort, AgentRuntimeRequest, AgentRuntimeResult } from '../src/ports/agent-runtime.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()

function messages(authSource: 'oauth' | 'user' | 'none' = 'oauth'): SDKMessage[] {
  return [
    {
      type: 'system', subtype: 'init', apiKeySource: authSource,
      claude_code_version: '2.1.224', cwd: root, tools: ['Read', 'Glob', 'Grep'],
      mcp_servers: [], model: 'claude-sonnet-test', permissionMode: 'dontAsk',
      slash_commands: [], output_style: 'default', skills: [], plugins: [],
      uuid: '11111111-1111-4111-8111-111111111111',
      session_id: '22222222-2222-4222-8222-222222222222'
    },
    {
      type: 'result', subtype: 'success', duration_ms: 10, duration_api_ms: 5,
      is_error: false, num_turns: 1,
      result: 'Os contratos foram inspecionados sem alteração.', stop_reason: 'end_turn',
      total_cost_usd: 0.02, usage: {} as never,
      modelUsage: {
        'claude-sonnet-test': {
          inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30,
          cacheCreationInputTokens: 10, webSearchRequests: 0, costUSD: 0.02,
          contextWindow: 200000, maxOutputTokens: 8192
        }
      },
      permission_denials: [],
      uuid: '33333333-3333-4333-8333-333333333333',
      session_id: '22222222-2222-4222-8222-222222222222'
    }
  ] as SDKMessage[]
}

function fakeQuery(
  source: SDKMessage[],
  account = { apiProvider: 'firstParty' as const, subscriptionType: 'Claude Max' }
): Query {
  let closed = false
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of source) {
        if (closed) return
        yield message
      }
    },
    close() { closed = true },
    async accountInfo() { return account }
  } as unknown as Query
}

function runtimeRequest(): AgentRuntimeRequest {
  return {
    runId: 'runtime-test-0001', cwd: root, objective: 'Inspecione os contratos.',
    instructions: 'Somente leitura.', tools: ['Read', 'Glob', 'Grep'],
    maxTurns: 3, timeoutMs: 10_000,
    authorization: {
      enforcementId: 'authenf-runtime-test-0001',
      enforcementFingerprint: `sha256:${'1'.repeat(64)}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      operations: ['filesystem.read'], requiredControls: ['sanitize-output']
    }
  }
}

test('adaptador exige login OAuth, remove chaves e limita ferramentas', async () => {
  let captured: Options | undefined
  const runtime = new AnthropicAgentSdkRuntime(
    ({ options }) => { captured = options; return fakeQuery(messages()) },
    {
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: 'não-pode-vazar',
      ANTHROPIC_AUTH_TOKEN: 'também-não',
      ANTHROPIC_BASE_URL: 'https://proxy.invalid'
    }
  )
  const request = runtimeRequest()
  request.resumeSessionId = 'session-anterior-0001'
  const result = await runtime.run(request)
  assert.equal(result.authSource, 'oauth-login')
  assert.equal(result.sessionId, '22222222-2222-4222-8222-222222222222')
  assert.equal(result.usage.inputTokens, 100)
  assert.equal(result.usage.estimatedCostUsd, 0.02)
  assert.ok(captured)
  assert.equal(captured.env?.ANTHROPIC_API_KEY, undefined)
  assert.equal(captured.env?.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(captured.env?.ANTHROPIC_BASE_URL, undefined)
  assert.deepEqual(captured.tools, ['Read', 'Glob', 'Grep'])
  assert.deepEqual(captured.allowedTools, [])
  assert.equal(captured.permissionMode, 'dontAsk')
  assert.deepEqual(captured.settingSources, [])
  assert.equal(captured.resume, 'session-anterior-0001')
  const gate = captured.canUseTool
  assert.ok(gate)
  const permissionContext = {
    signal: new AbortController().signal,
    toolUseID: 'tool-use-test-0001',
    requestId: 'permission-request-test-0001'
  }
  const readDecision = await gate('Read', { file_path: 'README.md' }, permissionContext)
  const bashDecision = await gate('Bash', { command: 'echo no' }, permissionContext)
  assert.ok(readDecision)
  assert.ok(bashDecision)
  assert.equal(readDecision.behavior, 'allow')
  assert.equal(bashDecision.behavior, 'deny')
})

test('adaptador rejeita qualquer fonte de autenticação diferente do login OAuth', async () => {
  const runtime = new AnthropicAgentSdkRuntime(() => fakeQuery(messages('user')))
  await assert.rejects(runtime.run(runtimeRequest()), AnthropicLoginRequiredError)
})

test('PreToolUse verifica o crachá mesmo sem callback e preserva as permissões de caminho do SDK', async () => {
  let captured: Options | undefined
  let now = new Date('2026-09-23T12:00:00.000Z')
  const runtime = new AnthropicAgentSdkRuntime(({ options }) => {
    captured = options
    return fakeQuery(messages())
  }, {}, () => now)
  const request = runtimeRequest()
  request.authorization.expiresAt = '2026-09-23T12:01:00.000Z'
  const result = await runtime.run(request)
  const hook = captured?.hooks?.PreToolUse?.[0]?.hooks[0]
  assert.ok(hook)
  const input = {
    hook_event_name: 'PreToolUse' as const, tool_name: 'Read', tool_input: { file_path: 'private-path' },
    tool_use_id: 'read-0001', session_id: 'test-session', transcript_path: '', cwd: root
  }
  const context = { signal: new AbortController().signal }
  // Empty output defers to normal SDK path rules; it must not force allow.
  assert.deepEqual(await hook(input, input.tool_use_id, context), {})
  assert.deepEqual(await hook({ ...input, tool_name: 'Bash' }, 'bash-0001', context), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Ferramenta Bash não pertence à autorização do plano.' }
  })
  now = new Date(request.authorization.expiresAt)
  assert.deepEqual(await hook(input, 'read-expired', context), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'A autorização do Omni expirou durante a execução.' }
  })
  assert.ok(result.events.some((event) => event.type === 'tool-allowed' && event.data.source === 'pre-tool-use'))
  assert.ok(result.events.some((event) => event.type === 'tool-denied' && event.data.reason === 'authorization-expired'))
  assert.doesNotMatch(JSON.stringify(result.events), /private-path/)
})

test('negação interna do SDK registra ferramenta sem copiar entrada privada para eventos', async () => {
  const source = messages()
  const final = source.find((message) => message.type === 'result')!
  assert.equal(final.type, 'result')
  final.permission_denials = [{ tool_name: 'Read', tool_use_id: 'tool-denied-example', tool_input: { file_path: 'private-secret-path' } }]
  const runtime = new AnthropicAgentSdkRuntime(() => fakeQuery(source))
  const result = await runtime.run(runtimeRequest())
  assert.equal(result.permissionDenials, 1)
  assert.ok(result.events.some((event) => event.type === 'tool-denied' && event.data.toolName === 'Read' && event.data.reason === 'sdk-permission-denial'))
  assert.doesNotMatch(JSON.stringify(result.events), /private-secret-path/)
})

test('adaptador comprova login Claude Max quando o init do SDK informa none', async () => {
  const runtime = new AnthropicAgentSdkRuntime(() => fakeQuery(messages('none')))
  const result = await runtime.run(runtimeRequest())
  assert.equal(result.authSource, 'oauth-login')
  assert.equal(result.events[0]?.data.authProof, 'account-first-party-subscription')
})

test('Discovery assistida usa OAuth, mas nÃ£o recebe ferramenta nem permissÃ£o de leitura', async () => {
  let captured: Options | undefined
  const runtime = new AnthropicAgentSdkRuntime(({ options }) => {
    captured = options
    return fakeQuery(messages())
  })
  const request = runtimeRequest()
  request.purpose = 'discovery'
  request.tools = []
  request.authorization.operations = ['discovery.analyze']
  await runtime.run(request)
  assert.ok(captured)
  assert.deepEqual(captured.tools, [])
  assert.deepEqual(captured.allowedTools, [])
})

test('Discovery assistida rejeita qualquer ferramenta antes de chamar o SDK', async () => {
  const runtime = new AnthropicAgentSdkRuntime(() => fakeQuery(messages()))
  const request = runtimeRequest()
  request.purpose = 'discovery'
  request.authorization.operations = ['discovery.analyze']
  await assert.rejects(runtime.run(request), /Discovery assistida/)
})

class FakeAgentRuntime implements AgentRuntimePort {
  lastRequest?: AgentRuntimeRequest
  async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    this.lastRequest = request
    return {
      engine: 'anthropic-claude-agent-sdk', sdkVersion: '0.3.224-test',
      authSource: 'oauth-login', sessionId: 'session-agent-runtime-test-0001',
      model: 'claude-sonnet-test', output: 'Relatório de inspeção produzido pelo dublê do SDK.',
      durationMs: 50, turns: 1,
      usage: {
        inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10, estimatedCostUsd: 0.02
      },
      permissionDenials: 0,
      events: [{
        sequence: 1, type: 'runtime-started', occurredAt: '2026-08-31T16:00:00.000Z',
        data: { authSource: 'oauth-login' }
      }]
    }
  }
}

test('Task State e TaskResult recebem sessão, uso e evidência do Agent SDK', async () => {
  const validator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const runtime = new FakeAgentRuntime()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const worker = new TaskWorker(
    'worker-agent-runtime-test', store, validator,
    new AgentAssistedContractInspectionExecutor(runtime)
  )
  const fixturePath = join(root, 'contratos', 'exemplos', 'task-request-inspecao-executavel.json')
  const request = JSON.parse(await readFile(fixturePath, 'utf8')) as TaskRequest
  request.context.references[0]!.uri = pathToFileURL(root).href
  request.requestId = 'req-agent-runtime-inspection-0001'
  request.idempotencyKey = 'agent-runtime-inspection-0001'

  await manager.submit(request)
  const completed = await worker.runOnce()
  assert.equal(completed?.status, 'succeeded')
  assert.deepEqual(runtime.lastRequest?.tools, ['Read', 'Glob', 'Grep'])
  assert.deepEqual(runtime.lastRequest?.authorization.operations.sort(), ['filesystem.read', 'runtime.assemble-report'])
  const attempt = (completed?.state.ledger.attempts as Array<Record<string, unknown>>)[0]
  const binding = attempt?.runtimeBinding as Record<string, unknown>
  assert.equal(binding.authSource, 'oauth-login')
  assert.equal(binding.sessionId, 'session-agent-runtime-test-0001')
  assert.equal(completed?.state.usage.tokens, 120)
  assert.equal((completed?.result?.execution as Record<string, unknown>).costUsd, 0.02)
  assert.equal((completed?.result?.evidence as unknown[]).length, 3)
})
