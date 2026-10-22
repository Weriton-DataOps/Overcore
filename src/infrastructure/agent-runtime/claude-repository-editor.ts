import { isAbsolute, resolve } from 'node:path'

import type {
  CanUseTool,
  HookCallback,
  Options,
  Query,
  SDKResultMessage
} from '@anthropic-ai/claude-agent-sdk'

import type { RepositoryEditInput, RepositoryEditOutcome, RepositoryEditor } from '../../ports/repository-editor.js'
import { AnthropicLoginRequiredError, isSubscriptionLogin, loginOnlyEnvironment } from './anthropic-agent-sdk.js'

type QueryFactory = (input: { prompt: string; options?: Options }) => Query

const EDITOR_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'] as const
const WRITE_TOOLS = new Set(['Edit', 'Write'])
const NEVER_AVAILABLE = ['Agent', 'Bash', 'NotebookEdit', 'Task', 'Skill', 'WebFetch', 'WebSearch']

function field(input: unknown, name: string): unknown {
  return input && typeof input === 'object' ? (input as Record<string, unknown>)[name] : undefined
}

function escapingPattern(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false
  return pattern.startsWith('/') || pattern.includes('\\') || /^[A-Za-z]:/.test(pattern) || pattern.split('/').includes('..')
}

/**
 * Editor da bancada (ADR-022) sobre o Claude Agent SDK.
 *
 * Só lê e edita arquivos; não tem shell. Escrita exige o guarda da bancada;
 * leitura fora do `include` é permitida para dar contexto, mas `exclude`,
 * `.git` e qualquer caminho fora do worktree são negados antes do disco.
 * A prova continua sendo o diff medido pela bancada, não o relato.
 */
export class ClaudeRepositoryEditor implements RepositoryEditor {
  constructor(
    private readonly queryFactory?: QueryFactory,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly maxTurns = 60
  ) {}

  async edit(input: RepositoryEditInput, signal: AbortSignal): Promise<RepositoryEditOutcome> {
    if (!isAbsolute(input.worktreePath)) throw new Error('O editor exige worktree absoluto.')
    const root = resolve(input.worktreePath)
    const denials: string[] = []

    const assess = async (toolName: string, toolInput: unknown): Promise<string | undefined> => {
      if (!(EDITOR_TOOLS as readonly string[]).includes(toolName)) return `Ferramenta ${toolName} não pertence à bancada.`
      if (escapingPattern(field(toolInput, 'pattern')) || escapingPattern(field(toolInput, 'glob'))) {
        return 'Padrões de busca precisam ser relativos ao worktree, sem "..".'
      }
      const write = WRITE_TOOLS.has(toolName)
      const candidate = toolName === 'Glob' || toolName === 'Grep' ? field(toolInput, 'path') : field(toolInput, 'file_path')
      if (candidate === undefined && !write && toolName !== 'Read') return undefined
      if (typeof candidate !== 'string') return 'Caminho ausente ou inválido.'
      if (!write && resolve(root, candidate) === root) return undefined
      const decision = await input.checkPath(candidate)
      if (decision.allowed) return undefined
      if (!write && decision.reason === 'not-included') return undefined
      return `${decision.reason}: ${decision.detail}`
    }
    const deny = (toolName: string, reason: string) => {
      denials.push(`${toolName}: ${reason}`)
      return reason
    }
    const canUseTool: CanUseTool = async (toolName, toolInput) => {
      const denial = await assess(toolName, toolInput)
      return denial ? { behavior: 'deny', message: deny(toolName, denial) } : { behavior: 'allow', updatedInput: toolInput }
    }
    // O hook decide antes do sistema de permissões do SDK: nega fora do
    // escopo e aprova explicitamente o resto, já que dontAsk negaria tudo.
    const beforeTool: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {}
      const denial = await assess(hookInput.tool_name, hookInput.tool_input)
      return {
        hookSpecificOutput: denial
          ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny(hookInput.tool_name, denial) }
          : { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
      }
    }

    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })

    const options: Options = {
      abortController: controller,
      cwd: root,
      tools: [...EDITOR_TOOLS],
      allowedTools: [],
      disallowedTools: NEVER_AVAILABLE,
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [beforeTool] }] },
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      maxTurns: this.maxTurns,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: [
          'Você trabalha numa worktree descartável do Overcore; o branch só nasce se a verificação passar depois de você.',
          `Escreva somente em caminhos que casem com ${JSON.stringify(input.pathScope.include)} e nunca em ${JSON.stringify(input.pathScope.exclude)}.`,
          'Não há shell nem rede. Não tente rodar testes; a verificação declarada roda depois, fora do seu controle.',
          'Termine com um resumo curto em Markdown: o que mudou, onde, e qualquer dúvida que ficou.'
        ].join('\n')
      },
      env: loginOnlyEnvironment(this.env),
      ...(input.maxCostUsd === undefined ? {} : { maxBudgetUsd: input.maxCostUsd })
    }

    const factory = this.queryFactory ?? (await import('@anthropic-ai/claude-agent-sdk')).query
    const prompt = `${input.objective}\n\nInstruções:\n${input.instructions}`
    const query = factory({ prompt, options })
    let started = false
    let final: SDKResultMessage | undefined
    try {
      for await (const message of query) {
        if (message.type === 'system' && message.subtype === 'init') {
          const source = String(message.apiKeySource)
          if (source === 'none') {
            if (!isSubscriptionLogin(await query.accountInfo())) throw new AnthropicLoginRequiredError(source)
          } else if (source !== 'oauth') {
            throw new AnthropicLoginRequiredError(source)
          }
          started = true
        }
        if (message.type === 'result') final = message
      }
      if (!started) throw new AnthropicLoginRequiredError()
      if (!final) throw new Error('Claude Agent SDK encerrou sem mensagem result.')
      if (final.subtype !== 'success' || final.is_error) {
        const details = final.subtype === 'success' ? 'resultado marcado como erro' : final.errors.join('; ')
        throw new Error(`O editor não concluiu: ${final.subtype}: ${details}`)
      }
      const usage = Object.values(final.modelUsage)
      const tokens = usage.reduce((total, item) => total + item.inputTokens + item.outputTokens, 0)
      const costUsd = usage.reduce((total, item) => total + item.costUSD, 0)
      const denied = denials.length > 0
        ? `\n\n### Ferramentas negadas pelo guarda\n\n${denials.slice(0, 20).map((item) => `- ${item}`).join('\n')}`
        : ''
      return { report: `${final.result}${denied}`, tokens, costUsd }
    } finally {
      signal.removeEventListener('abort', abort)
      query.close()
    }
  }
}
