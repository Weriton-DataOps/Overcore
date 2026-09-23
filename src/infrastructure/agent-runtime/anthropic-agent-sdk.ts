import { isAbsolute } from 'node:path'

import type {
  AccountInfo,
  CanUseTool,
  HookCallback,
  Options,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage
} from '@anthropic-ai/claude-agent-sdk'

import type {
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
  AgentRuntimePort,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  AgentRuntimeTool,
  AgentRuntimeUsage
} from '../../ports/agent-runtime.js'

const SDK_VERSION = '0.3.224'
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const NEVER_AVAILABLE = [
  'Agent', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Skill',
  'WebFetch', 'WebSearch'
]
const API_CREDENTIAL_ENV = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL'
])
const CLAUDE_SUBSCRIPTION = /^claude\s+(free|pro|max|team|enterprise)$/i

type QueryFactory = (input: { prompt: string; options?: Options }) => Query

export class AnthropicLoginRequiredError extends Error {
  constructor(source?: string) {
    super(source
      ? `Claude Agent SDK iniciou com autenticação '${source}', mas o Overcore exige login OAuth.`
      : 'Claude Agent SDK não comprovou um login OAuth ativo.')
    this.name = 'AnthropicLoginRequiredError'
  }
}

function loginOnlyEnvironment(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(source)) {
    if (!API_CREDENTIAL_ENV.has(name)) env[name] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'overcore/0.1.0'
  return env
}

function isSubscriptionLogin(account: AccountInfo): boolean {
  const accountSource = account.apiKeySource?.toLowerCase()
  return account.apiProvider === 'firstParty'
    && typeof account.subscriptionType === 'string'
    && CLAUDE_SUBSCRIPTION.test(account.subscriptionType.trim())
    && (accountSource === undefined || accountSource === 'oauth' || accountSource === 'none')
}

function validateRequest(request: AgentRuntimeRequest, now: Date): void {
  if (!isAbsolute(request.cwd)) throw new Error('Agent Runtime exige cwd absoluto.')
  if (Date.parse(request.authorization.expiresAt) <= now.getTime()) {
    throw new Error('Autorização expirou antes de iniciar o Claude Agent SDK.')
  }
  if (request.purpose === 'discovery') {
    if (!request.authorization.operations.includes('discovery.analyze')) {
      throw new Error('A Discovery assistida não recebeu autorização para discovery.analyze.')
    }
    if (request.tools.length !== 0) throw new Error('A Discovery assistida não recebe ferramentas.')
  } else {
    if (!request.authorization.operations.includes('filesystem.read')) {
      throw new Error('A execução do SDK não recebeu autorização para filesystem.read.')
    }
    if (request.tools.length === 0 || request.tools.some((tool) => !READ_ONLY_TOOLS.has(tool))) {
      throw new Error('A primeira integração do SDK aceita somente Read, Glob e Grep.')
    }
  }
  if (!request.authorization.requiredControls.includes('sanitize-output')) {
    throw new Error('A autorização do SDK não contém o controle sanitize-output.')
  }
}

function usageOf(result: SDKResultMessage): AgentRuntimeUsage {
  const values = Object.values(result.modelUsage)
  return values.reduce<AgentRuntimeUsage>((total, usage) => ({
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + usage.cacheReadInputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    estimatedCostUsd: total.estimatedCostUsd + usage.costUSD
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    estimatedCostUsd: 0
  })
}

function textBlocks(message: SDKMessage): string[] {
  if (message.type !== 'assistant') return []
  return message.message.content
    .filter((block): block is Extract<(typeof message.message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
}

function toolBlocks(message: SDKMessage): Array<{ name: string; input: unknown }> {
  if (message.type !== 'assistant') return []
  return message.message.content
    .filter((block): block is Extract<(typeof message.message.content)[number], { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => ({ name: block.name, input: block.input }))
}

export class AnthropicAgentSdkRuntime implements AgentRuntimePort {
  constructor(
    private readonly queryFactory?: QueryFactory,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => Date = () => new Date()
  ) {}

  async run(
    request: AgentRuntimeRequest,
    onEvent?: AgentRuntimeEventSink,
    signal?: AbortSignal
  ): Promise<AgentRuntimeResult> {
    const startedAt = this.now()
    validateRequest(request, startedAt)
    const events: AgentRuntimeEvent[] = []
    let sequence = 0
    const emit = async (type: AgentRuntimeEvent['type'], data: Record<string, unknown>) => {
      const event: AgentRuntimeEvent = {
        sequence: ++sequence,
        type,
        occurredAt: this.now().toISOString(),
        data
      }
      events.push(event)
      await onEvent?.(event)
    }

    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('Tempo do Agent Runtime esgotado.')), request.timeoutMs)
    timeout.unref()

    const allowed = new Set(request.tools)
    const assessTool = async (toolName: string, source: string) => {
      await emit('tool-requested', { toolName, source })
      if (Date.parse(request.authorization.expiresAt) <= this.now().getTime()) {
        await emit('tool-denied', { toolName, source, reason: 'authorization-expired' })
        return 'A autorização do Omni expirou durante a execução.'
      }
      if (!allowed.has(toolName as AgentRuntimeTool)) {
        await emit('tool-denied', { toolName, source, reason: 'outside-authorized-tool-set' })
        return `Ferramenta ${toolName} não pertence à autorização do plano.`
      }
      await emit('tool-allowed', {
        toolName, source,
        enforcementId: request.authorization.enforcementId,
        enforcementFingerprint: request.authorization.enforcementFingerprint
      })
      return undefined
    }
    const canUseTool: CanUseTool = async (toolName, input) => {
      const denial = await assessTool(toolName, 'permission-callback')
      if (denial) return { behavior: 'deny', message: denial }
      return { behavior: 'allow', updatedInput: input }
    }
    // Built-in reads inside cwd may bypass canUseTool, including in dontAsk.
    // This hook checks the badge first, then leaves the SDK's path permissions intact.
    const beforeTool: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {}
      const denial = await assessTool(input.tool_name, 'pre-tool-use')
      return denial ? {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denial
        }
      } : {}
    }

    const options: Options = {
      abortController: controller,
      cwd: request.cwd,
      tools: [...request.tools],
      // No broad auto-approval. PreToolUse validates authorization even when
      // a built-in tool would approve its own read without invoking canUseTool.
      allowedTools: [],
      disallowedTools: NEVER_AVAILABLE,
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [beforeTool] }] },
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: true,
      maxTurns: request.maxTurns,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: request.instructions
      },
      env: loginOnlyEnvironment(this.env),
      ...(request.maxCostUsd === undefined ? {} : { maxBudgetUsd: request.maxCostUsd }),
      ...(request.resumeSessionId === undefined ? {} : { resume: request.resumeSessionId })
    }

    const factory = this.queryFactory ?? (await import('@anthropic-ai/claude-agent-sdk')).query
    const query = factory({ prompt: request.objective, options })
    let init: SDKSystemMessage | undefined
    let final: SDKResultMessage | undefined
    let output = ''
    try {
      for await (const message of query) {
        if (message.type === 'system' && message.subtype === 'init') {
          init = message
          const reportedSource = String(message.apiKeySource)
          let authProof = 'system-init-oauth'
          if (reportedSource === 'none') {
            const account = await query.accountInfo()
            if (isSubscriptionLogin(account)) authProof = 'account-first-party-subscription'
            else {
              query.close()
              throw new AnthropicLoginRequiredError(reportedSource)
            }
          } else if (reportedSource !== 'oauth') {
            query.close()
            throw new AnthropicLoginRequiredError(reportedSource)
          }
          await emit('runtime-started', {
            engine: 'anthropic-claude-agent-sdk',
            sdkVersion: SDK_VERSION,
            sessionId: message.session_id,
            model: message.model,
            authSource: 'oauth-login',
            authProof
          })
        }
        for (const text of textBlocks(message)) {
          output += text
          await emit('assistant-text', { characters: text.length })
        }
        for (const tool of toolBlocks(message)) {
          await emit('tool-requested', { toolName: tool.name, source: 'assistant-stream' })
        }
        if (message.type === 'rate_limit_event') {
          await emit('rate-limit', {
            status: message.rate_limit_info.status,
            rateLimitType: message.rate_limit_info.rateLimitType,
            utilization: message.rate_limit_info.utilization
          })
        }
        if (message.type === 'result') {
          final = message
          if (message.subtype === 'success') output = message.result
        }
      }
      if (!init) throw new AnthropicLoginRequiredError()
      if (!final) throw new Error('Claude Agent SDK encerrou sem mensagem result.')
      if (final.subtype !== 'success' || final.is_error) {
        const details = final.subtype === 'success' ? 'resultado marcado como erro' : final.errors.join('; ')
        throw new Error(`Claude Agent SDK não concluiu: ${final.subtype}: ${details}`)
      }
      const usage = usageOf(final)
      // SDK denials can happen before canUseTool is called (for example dontAsk).
      // Keep tool names observable without retaining inputs, file contents or secrets.
      for (const denial of final.permission_denials) {
        await emit('tool-denied', { toolName: denial.tool_name, reason: 'sdk-permission-denial' })
      }
      await emit('runtime-result', {
        status: 'succeeded',
        turns: final.num_turns,
        estimatedCostUsd: usage.estimatedCostUsd,
        permissionDenials: final.permission_denials.length
      })
      return {
        engine: 'anthropic-claude-agent-sdk',
        sdkVersion: SDK_VERSION,
        authSource: 'oauth-login',
        sessionId: init.session_id,
        model: init.model,
        output,
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        turns: final.num_turns,
        usage,
        permissionDenials: final.permission_denials.length,
        events
      }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      query.close()
    }
  }
}
