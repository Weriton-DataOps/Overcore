import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createPostgresPool, migrate } from '../.test-dist/src/infrastructure/database/postgres.js'
import { PostgresTaskStore } from '../.test-dist/src/infrastructure/database/postgres-task-store.js'
import { ContractValidator } from '../.test-dist/src/contracts/validator.js'
import { TaskManager } from '../.test-dist/src/application/task-manager.js'
import { TaskPreflight } from '../.test-dist/src/application/task-preflight.js'
import { TaskWorker } from '../.test-dist/src/application/task-worker.js'
import { BaselineDiscovery } from '../.test-dist/src/application/baseline-discovery.js'
import { AdaptiveDiscovery } from '../.test-dist/src/application/adaptive-discovery.js'
import { AgentAssistedContractInspectionExecutor } from '../.test-dist/src/application/inspection-executor.js'
import { ClaudeDiscoveryAdvisor } from '../.test-dist/src/infrastructure/discovery/claude-discovery-advisor.js'
import { AnthropicAgentSdkRuntime } from '../.test-dist/src/infrastructure/agent-runtime/anthropic-agent-sdk.js'
import { HttpAuthorityProvider } from '../.test-dist/src/infrastructure/authority/http-authority-provider.js'
import { createLocalServer } from '../.test-dist/src/infrastructure/http/local-server.js'
import { fingerprint } from '../.test-dist/src/domain/fingerprint.js'

test('cliente produtivo Omni responde ao Preflight e recebe resultado da mesma tarefa real', { timeout: 300_000 }, async t => {
  const reportCase = process.env.OVERCORE_FLOW_CASE === 'report-delivery'
  assert.equal(process.env.OVERCORE_RUN_OMNI_FLOW, 'I_UNDERSTAND_LOGIN_USAGE')
  const omniRoot = process.env.OVERCORE_OMNI_REPOSITORY_PATH
  assert.ok(omniRoot)
  const connection = new URL(process.env.OVERCORE_TEST_DATABASE_URL)
  assert.equal(connection.pathname, '/overcore_test')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname))
  const schema = `overcore_omni_flow_${randomBytes(8).toString('hex')}`
  const admin = createPostgresPool(connection.href)
  connection.searchParams.set('options', `-c search_path=${schema}`)
  const pool = createPostgresPool(connection.href)
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'overcore-omni-flow-')))
  const omniHome = join(directory, 'omni-private')
  const project = join(directory, 'project')
  let authority, server, created = false, success = false, evidence = null
  const runtimeCalls = []
  const observations = []
  try {
    assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, 'overcore_test')
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true
    await migrate(pool, process.cwd())
    await mkdir(join(project, 'contratos'), { recursive: true })
    await writeFile(join(project, 'contratos', 'request.schema.json'), JSON.stringify({ type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } }), { flag: 'wx' })
    const token = randomBytes(32).toString('hex')
    authority = spawn(process.execPath, [join(omniRoot, 'adaptadores', 'overcore-authority-http.mjs')], {
      cwd: omniRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMNI_AUTHORITY_PROVIDER_TOKEN: token, OMNI_AUTHORITY_PROVIDER_PORT: '0' }
    })
    authority.stderr.resume()
    const ready = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('Autoridade não iniciou.')), 10000)
      authority.once('error', reject)
      authority.stdout.on('data', chunk => {
        buffer += chunk
        if (buffer.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buffer.split('\n')[0])) }
      })
    })
    const sdk = new AnthropicAgentSdkRuntime(input => query({ ...input, options: { ...input.options, persistSession: false } }))
    const runtime = { async run(request, sink, signal) {
      process.stdout.write(`SDK ${request.purpose}: início; teto USD ${request.maxCostUsd ?? 'padrão'}\n`)
      try {
        const result = await sdk.run(request, sink, signal)
        runtimeCalls.push({ purpose: request.purpose, authSource: result.authSource, model: result.model, permissionDenials: result.permissionDenials, costUsd:result.usage.estimatedCostUsd, outputCharacters:result.output.length })
        process.stdout.write(`SDK ${request.purpose}: concluído; USD ${result.usage.estimatedCostUsd}\n`)
        return result
      } catch(error) {
        const reason = error instanceof Error ? error.message.slice(0,500) : 'Falha do SDK'
        runtimeCalls.push({purpose:request.purpose,status:'failed',reason})
        process.stdout.write(`SDK ${request.purpose}: ${reason}\n`)
        throw error
      }
    } }
    const store = new PostgresTaskStore(pool)
    const validator = await ContractValidator.create(process.cwd())
    const manager = new TaskManager(store, validator, new HttpAuthorityProvider(new URL(ready.url), token), undefined,
      new TaskPreflight(validator, new AdaptiveDiscovery(new BaselineDiscovery(), new ClaudeDiscoveryAdvisor(runtime, project)), store))
    const worker = new TaskWorker('worker-omni-flow-test', store, validator, new AgentAssistedContractInspectionExecutor(runtime))
    server = createLocalServer(manager, worker, token)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${server.address().port}`
    const { executarFluxoOvercore, contextoFluxosOvercore, observarFluxosOvercore } = await import(pathToFileURL(join(omniRoot, 'runtime/overcore-task-flow.mjs')).href)
    const env = { OVERCORE_URL: endpoint, OVERCORE_LOCAL_TOKEN: token }
    const session = 'owner-omni-flow-test'
    const context = { summary: 'Somente arquivos *.schema.json da subpasta contratos do repositório referenciado, sem recursão. Ainda definir verificação e saída.', references: [{ refId: 'ref-omni-flow-project', uri: pathToFileURL(project).href, kind: 'repository', sensitivity: 'public' }], assumptions: [] }
    const input = { objective: 'Inspecionar os *.schema.json no nível raiz de contratos, sem recursão e sem alterar arquivos.', context,
      knownConstraints: [{ id: 'constraint-no-write', kind: 'technical', description: 'Somente leitura, sem publicação ou modificações.' }],
      discoveryAuthority: { mode: 'inspect-only', grants: [{ resourceRef: 'ref-omni-flow-project', operations: [{ name: 'filesystem.read', effect: 'read' }] }] },
      availableExecutionAuthority: { mode: 'proceed-within-scope', grants: [{ resourceRef: 'ref-omni-flow-project', operations: ['filesystem.read'] }], expansionBoundaries: ['destructive', 'irreversible', 'financial', 'privilege-expansion', 'external-publication', 'secret-access'] } }
    if (reportCase) {
      const limits = {maxDurationMs:300000,maxAttempts:1,maxParallelism:1,maxCostUsd:1.5}
      input.executionBudget = {source:{kind:'policy-default',sourceId:'policy-report-regression',sourceVersion:'1.0',sourceDigest:fingerprint(limits).value},limits}
      context.references[0].uri = pathToFileURL(join(process.cwd(), 'contratos')).href
      context.references[0].kind = 'workspace'
      context.summary = 'Somente os seis *.schema.json diretamente na pasta exata referenciada, sem recursão. Entrega em Markdown na resposta, sem criar arquivo. Mapear função de cada contrato e analisar inconsistências observáveis apenas nesses arquivos; distinguir ausência nesta pasta de ausência no sistema. Não implementar correções.'
      context.assumptions = [{id:'assumption-directory-scope',statement:'A análise se limita à pasta referenciada, sem recursão.',impactIfFalse:'O conjunto autorizado de arquivos mudaria.'}]
      input.objective = 'Entregar mapa curto dos contratos existentes, função de cada um e eventuais inconsistências encontradas, somente em leitura.'
      input.knownAcceptanceCriteria = [
        {id:'criterion-inventory',description:'Lista exatamente os seis arquivos *.schema.json encontrados diretamente na pasta contratos.',verificationHint:'inspection'},
        {id:'criterion-map',description:'O relatório apresenta todos os seis arquivos e a função de cada contrato em mapa curto ou tabela.',verificationHint:'inspection'},
        {id:'criterion-inconsistencies',description:'O relatório analisa inconsistências entre os contratos com fundamento em seus campos, distingue hipóteses e limita conclusões ao escopo inspecionado.',verificationHint:'inspection'},
        {id:'criterion-no-mutation',description:'Nenhum arquivo da pasta contratos foi criado, alterado ou removido durante a execução.',verificationHint:'inspection'}
      ]
      input.executionHints = {expectedOutputKind:'no-artifact'}
    }
    const first = await executarFluxoOvercore(omniHome, session, { operation: 'prepare', input }, 'owner-turn-one', env)
    observations.push({ status: first.status, decisions: first.decisions })
    assert.equal(first.status, 'decisions-required'); assert.equal(first.taskId, null)
    assert.match(await contextoFluxosOvercore(omniHome, session, env), new RegExp(first.flowId))
    const nextInput = { reportId: first.reportId, answers: first.decisions.map(decision => ({ decisionId: decision.decisionId,
      optionId: decision.options.find(option => option.label === 'Confirmar a suposição' || option.label === 'Não produzir artefato')?.optionId || decision.recommendedOptionId })), changes: {
        context: { ...context, summary: 'Escolhas do proprietário neste roteiro: inventário de *.schema.json diretamente na subpasta contratos do repositório referenciado (não na raiz do repositório), sem recursão; testar JSON parseável e additionalProperties=false na raiz de cada schema; não avaliar aninhamentos nem referências internas. Resultado JSON em memória com nome, digest, readable, rootClosed, schemaCount e capturedAt; sem arquivo persistente. Os dois critérios são condições obrigatórias de aprovação da tarefa: um arquivo ilegível ou sem additionalProperties=false na raiz reprova a tarefa, mesmo que o inventário tenha sido produzido; não são apenas estatísticas. Sem arquivos, falhar por ausência de alvo verificável.' },
        knownAcceptanceCriteria: [{ id: 'criterion-json-readable', description: 'Todos os arquivos são JSON legível.', verificationHint: 'test' }, { id: 'criterion-root-closed', description: 'Todos declaram additionalProperties=false na raiz.', verificationHint: 'schema' }],
        executionHints: { expectedOutputKind: 'no-artifact' }
      } }
    if (reportCase) nextInput.changes = { context }
    const scheduled = await executarFluxoOvercore(omniHome, session, { operation: 'answer', flowId: first.flowId, input: nextInput }, 'owner-turn-two', env)
    observations.push({ status: scheduled.status, decisions: scheduled.decisions })
    assert.equal(scheduled.status, 'running', JSON.stringify(scheduled)); assert.equal(scheduled.draftId, first.draftId)
    const completed = await worker.runOnce()
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed.result))
    const [observed] = await observarFluxosOvercore(omniHome, session, env)
    assert.equal(observed.status, 'succeeded'); assert.equal(observed.taskId, scheduled.taskId)
    assert.equal((await executarFluxoOvercore(omniHome, session, { operation: 'answer', flowId: first.flowId, input: nextInput }, 'owner-turn-two', env)).taskId, scheduled.taskId)
    assert.equal(runtimeCalls.length, reportCase ? 4 : 3)
    assert.ok(runtimeCalls.every(call => call.authSource === 'oauth-login' && call.permissionDenials === 0))
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM overcore_tasks')).rows[0].total, 1)
    assert.equal(await worker.runOnce(), null)
    const report = observed.result.report
    assert.ok(report.content.trim())
    assert.equal(report.digest, `sha256:${createHash('sha256').update(report.content).digest('hex')}`)
    if (reportCase) {
      for (const name of ['task-draft','task-request','task-readiness-report','task-result','authorization-request','authorization-decision']) assert.ok(report.content.includes(name), name)
      assert.equal(observed.result.criteria.length,4)
      assert.ok(observed.result.criteria.every(criterion => criterion.status === 'passed' && criterion.evidenceRefs.every(ref => ref.startsWith(criterion.criterionId === 'criterion-no-mutation' ? 'evidence-no-mutation' : 'evidence-criterion-review'))))
      assert.equal(scheduled.revision,2)
    }
    evidence = { flowId: first.flowId, taskId: observed.taskId, statuses: [first.status, scheduled.status, observed.status], questions: first.decisions.length, runtimeCalls, report, criteria:observed.result.criteria, execution:observed.result.execution, reportCase }
    success = true
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    if (authority && authority.exitCode === null) { authority.kill(); await new Promise(resolve => { authority.once('exit', resolve); setTimeout(resolve, 5000).unref() }) }
    await pool.end()
    if (created) { assert.match(schema, /^overcore_omni_flow_[a-f0-9]{16}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`) }
    await admin.end()
    assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase())
    assert.ok(basename(directory).startsWith('overcore-omni-flow-'))
    await rm(directory, { recursive: true, force: true })
    const reports = join(process.cwd(), '.overcore-runtime', 'evaluations', 'omni-flow')
    await mkdir(reports, { recursive: true })
    const file = join(reports, `flow-${Date.now()}.json`)
    await writeFile(file, JSON.stringify({ success, evidence, observations, runtimeCalls, cleanupComplete: true, note: 'Cliente produtivo Omni + peer real; respostas do proprietário roteirizadas. Não é avaliação comportamental humana.' }, null, 2), { flag: 'wx' })
    t.diagnostic(file)
  }
})
