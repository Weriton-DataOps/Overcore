import assert from 'node:assert/strict'
import test from 'node:test'

import { AnthropicAgentSdkRuntime } from '../src/infrastructure/agent-runtime/anthropic-agent-sdk.js'

test('Claude Agent SDK executa por login OAuth sem chave de API', async () => {
  if (process.env.OVERCORE_RUN_LIVE_SDK_TEST !== 'I_UNDERSTAND_LOGIN_USAGE') {
    throw new Error(
      'Gate não executado: defina OVERCORE_RUN_LIVE_SDK_TEST=I_UNDERSTAND_LOGIN_USAGE para consumir uma resposta do login Claude.'
    )
  }
  const runtime = new AnthropicAgentSdkRuntime()
  const result = await runtime.run({
    runId: 'live-login-sdk-smoke-0001', cwd: process.cwd(),
    objective: 'Leia package.json e responda somente com o campo name.',
    instructions: 'Teste de integração somente leitura. Não altere arquivos.',
    tools: ['Read'], maxTurns: 2, timeoutMs: 120_000,
    authorization: {
      enforcementId: 'authenf-live-login-smoke-0001',
      enforcementFingerprint: `sha256:${'2'.repeat(64)}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      operations: ['filesystem.read'], requiredControls: ['sanitize-output']
    }
  })
  assert.equal(result.authSource, 'oauth-login')
  assert.match(result.output, /overcore/i)
})
