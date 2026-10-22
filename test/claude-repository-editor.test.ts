import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { HookCallback, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import { RepositoryPathGuard } from '../src/application/repository-path-guard.js'
import { AnthropicLoginRequiredError } from '../src/infrastructure/agent-runtime/anthropic-agent-sdk.js'
import { ClaudeRepositoryEditor } from '../src/infrastructure/agent-runtime/claude-repository-editor.js'
import type { RepositoryEditInput } from '../src/ports/repository-editor.js'

type ToolCall = [tool: string, input: Record<string, unknown>]

interface Observed {
  options?: Options | undefined
  prompt?: string
  decisions: Array<{ tool: string; canUseTool: string; hook: string }>
}

function init(apiKeySource: string): SDKMessage {
  return {
    type: 'system', subtype: 'init', apiKeySource,
    claude_code_version: '2.1.224', cwd: '.', tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    mcp_servers: [], model: 'claude-sonnet-test', permissionMode: 'dontAsk',
    slash_commands: [], output_style: 'default', skills: [], plugins: [],
    uuid: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222'
  } as unknown as SDKMessage
}

const RESULT = {
  type: 'result', subtype: 'success', duration_ms: 10, duration_api_ms: 5,
  is_error: false, num_turns: 2, result: 'Criei `src/novo.ts`.', stop_reason: 'end_turn',
  total_cost_usd: 0.03, usage: {},
  modelUsage: {
    'claude-sonnet-test': {
      inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 0.03, contextWindow: 200000, maxOutputTokens: 8192
    }
  },
  permission_denials: [],
  uuid: '33333333-3333-4333-8333-333333333333',
  session_id: '22222222-2222-4222-8222-222222222222'
} as unknown as SDKMessage

/** SDK falso: entre init e result, cada chamada passa pelo canUseTool e pelo hook do editor. */
function scriptedSdk(calls: ToolCall[], observed: Observed, apiKeySource = 'oauth') {
  return ({ prompt, options }: { prompt: string; options?: Options }): Query => {
    observed.options = options
    observed.prompt = prompt
    let closed = false
    return {
      async *[Symbol.asyncIterator]() {
        yield init(apiKeySource)
        for (const [tool, input] of calls) {
          if (closed) return
          const signal = new AbortController().signal
          const permission = await options!.canUseTool!(tool, input, { signal, suggestions: [], toolUseID: 'tool-1' } as never)
          const hook = options!.hooks!.PreToolUse![0]!.hooks[0] as HookCallback
          const output = await hook({
            hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input,
            session_id: 's', transcript_path: '', cwd: '', tool_use_id: 'tool-1'
          } as never, 'tool-1', { signal })
          const specific = (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          observed.decisions.push({ tool, canUseTool: String(permission?.behavior), hook: String(specific?.permissionDecision) })
        }
        yield RESULT
      },
      close() { closed = true },
      async accountInfo() { return { apiProvider: 'firstParty', subscriptionType: 'Claude Max' } }
    } as unknown as Query
  }
}

async function worktree() {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-editor-'))
  await mkdir(join(directory, 'src'))
  await mkdir(join(directory, '.git'))
  await writeFile(join(directory, 'src', 'app.ts'), 'export const a = 1\n')
  await writeFile(join(directory, 'README.md'), '# repo\n')
  await writeFile(join(directory, '.env'), 'NADA=1\n')
  const pathScope = { include: ['src/**'], exclude: ['.env*', '**/*.pem'] }
  const guard = await RepositoryPathGuard.create(directory, pathScope)
  const input: RepositoryEditInput = {
    taskId: 'task-editor-0001',
    worktreePath: directory,
    objective: 'Adicionar src/novo.ts.',
    instructions: 'Criar o arquivo novo.',
    pathScope,
    checkPath: (candidate) => guard.check(candidate),
    timeoutMs: 60_000,
    maxCostUsd: 0.25
  }
  return { directory, input }
}

test('editor do Claude: o guarda libera leitura de contexto, escreve só no escopo e nega shell, .git, exclude e fuga', async () => {
  const { directory, input } = await worktree()
  try {
    const calls: ToolCall[] = [
      ['Write', { file_path: 'src/novo.ts', content: 'x' }],
      ['Edit', { file_path: join(directory, 'src', 'app.ts'), old_string: '1', new_string: '2' }],
      ['Read', { file_path: 'README.md' }],
      ['Glob', { pattern: 'src/**/*.ts' }],
      ['Grep', { pattern: 'answer', path: '.' }],
      ['Bash', { command: 'git push' }],
      ['WebFetch', { url: 'https://exemplo.invalid' }],
      ['Write', { file_path: 'README.md', content: 'x' }],
      ['Read', { file_path: '.env' }],
      ['Read', { file_path: '.git/config' }],
      ['Read', { file_path: '../fora.txt' }],
      ['Glob', { pattern: '../**' }],
      ['Grep', { pattern: 'x', glob: 'C:/Windows/**' }]
    ]
    const observed: Observed = { decisions: [] }
    const editor = new ClaudeRepositoryEditor(scriptedSdk(calls, observed), { PATH: 'x', ANTHROPIC_API_KEY: 'nao-usar' })
    const outcome = await editor.edit(input, new AbortController().signal)

    assert.deepEqual(observed.decisions.map((item) => [item.tool, item.canUseTool, item.hook]), [
      ['Write', 'allow', 'allow'],
      ['Edit', 'allow', 'allow'],
      ['Read', 'allow', 'allow'],
      ['Glob', 'allow', 'allow'],
      ['Grep', 'allow', 'allow'],
      ['Bash', 'deny', 'deny'],
      ['WebFetch', 'deny', 'deny'],
      ['Write', 'deny', 'deny'],
      ['Read', 'deny', 'deny'],
      ['Read', 'deny', 'deny'],
      ['Read', 'deny', 'deny'],
      ['Glob', 'deny', 'deny'],
      ['Grep', 'deny', 'deny']
    ])
    const options = observed.options!
    assert.equal(options.permissionMode, 'dontAsk')
    assert.deepEqual(options.settingSources, [])
    assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write'])
    assert.ok(options.disallowedTools?.includes('Bash'))
    assert.equal(options.cwd, directory)
    assert.equal(options.maxBudgetUsd, 0.25)
    assert.equal(options.persistSession, false)
    assert.equal(options.env?.ANTHROPIC_API_KEY, undefined, 'chave de API nunca chega ao editor')
    assert.match(String(observed.prompt), /Adicionar src\/novo\.ts\./)
    assert.match(outcome.report, /^Criei `src\/novo\.ts`\./)
    assert.match(outcome.report, /### Ferramentas negadas pelo guarda/)
    assert.equal(outcome.tokens, 150)
    assert.equal(outcome.costUsd, 0.03)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('editor do Claude recusa sessão que não é login de assinatura', async () => {
  const { directory, input } = await worktree()
  try {
    const editor = new ClaudeRepositoryEditor(scriptedSdk([], { decisions: [] }, 'user'), { PATH: 'x' })
    await assert.rejects(editor.edit(input, new AbortController().signal), AnthropicLoginRequiredError)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
