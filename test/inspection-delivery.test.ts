import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ReadOnlyContractInspectionExecutor, AgentAssistedContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { parseAssessment, deterministicCheck } from '../src/application/inspection-verification.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'
import { sha256 } from '../src/domain/fingerprint.js'
import type { TaskRequest } from '../src/domain/types.js'
import type { AgentRuntimePort } from '../src/ports/agent-runtime.js'

const root = process.cwd()
async function fixture(): Promise<TaskRequest> {
  const request = JSON.parse(await readFile(join(root, 'contratos/exemplos/task-request-inspecao-executavel.json'), 'utf8')) as TaskRequest
  request.context.references[0]!.uri = pathToFileURL(join(root, 'contratos')).href
  request.context.references[0]!.kind = 'workspace'
  return request
}
const criterion = { id: 'criterion-map', description: 'Mapa das funções de todos os contratos.', verification: { method: 'inspection' as const, expected: 'Mapa das funções de todos os contratos.' } }

test('pasta exata atravessa admissão, plano, executor e TaskResult com relatório e hash', async () => {
  const validator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  await new TaskManager(store, validator, new PermittingAuthorityProvider()).submit(await fixture())
  const task = await new TaskWorker('worker-delivery', store, validator, new ReadOnlyContractInspectionExecutor()).runOnce()
  assert.equal(task?.status, 'succeeded')
  const report = task?.result?.report as { content: string; digest: string }
  assert.equal(report.digest, sha256(report.content))
  assert.equal(JSON.parse(report.content).schemaCount, 6)
  validator.assert('task-result', task?.result)
})

test('JSON parseável nunca aprova um mapa ou critério desconhecido, qualquer que seja o método', async () => {
  for (const method of ['test', 'schema', 'inspection'] as const) {
    const request = await fixture()
    request.acceptanceCriteria = [{ ...criterion, verification: { ...criterion.verification, method } }]
    assert.equal(deterministicCheck(request.acceptanceCriteria[0]!), undefined)
    const validator = await ContractValidator.create(root)
    const store = new InMemoryTaskStore()
    await new TaskManager(store, validator, new PermittingAuthorityProvider()).submit(request)
    const task = await new TaskWorker('worker-no-false-pass', store, validator, new ReadOnlyContractInspectionExecutor()).runOnce()
    assert.notEqual(task?.status, 'succeeded')
    assert.ok((task?.result?.criteria as Array<{status: string}>).every(item => item.status !== 'passed'))
  }
})

test('avaliador rejeita citações inventadas, critérios repetidos e aprovação sem fonte', () => {
  const row = { criterionId: criterion.id, status: 'passed', reason: 'Mapa cobre fonte.', reportQuotes: ['Mapa'], sourceQuotes: [{file:'a.json',quote:'object'}] }
  assert.equal(parseAssessment(JSON.stringify([row]), [criterion], 'Mapa de contratos', {'a.json':'object'})[0]?.status, 'passed')
  assert.throws(() => parseAssessment(JSON.stringify([{...row, reportQuotes:['inventado']}]), [criterion], 'Mapa', {'a.json':'object'}))
  assert.throws(() => parseAssessment(JSON.stringify([{...row, sourceQuotes:[]}]), [criterion], 'Mapa', {}))
  assert.throws(() => parseAssessment(JSON.stringify([row,row]), [criterion], 'Mapa', {}))
})

test('avaliação independente reprova relatório irrelevante sem promover tarefa e respeita orçamento restante', async () => {
  const calls: Array<{purpose: string | undefined; maxCostUsd: number | undefined}> = []
  const runtime: AgentRuntimePort = { async run(input) {
    calls.push({purpose:input.purpose, maxCostUsd:input.maxCostUsd})
    return { engine:'anthropic-claude-agent-sdk', sdkVersion:'test', authSource:'oauth-login', sessionId:`session-${calls.length}`, model:'test',
      output: input.purpose === 'verification' ? JSON.stringify([{criterionId:criterion.id,status:'failed',reason:'Mapa ausente.',reportQuotes:[],sourceQuotes:[]}]) : 'OK, JSON legível.',
      durationMs:1, turns:1, usage:{inputTokens:1,outputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:0,estimatedCostUsd:0.1}, permissionDenials:0, events:[] }
  } }
  const request = await fixture(); request.acceptanceCriteria = [criterion]; request.budget.maxCostUsd = 0.75
  const store = new InMemoryTaskStore(); const validator = await ContractValidator.create(root)
  await new TaskManager(store,validator,new PermittingAuthorityProvider()).submit(request)
  const task = await new TaskWorker('worker-review',store,validator,new AgentAssistedContractInspectionExecutor(runtime)).runOnce()
  assert.notEqual(task?.status,'succeeded')
  assert.deepEqual(calls.map(c=>c.purpose),['execution','verification'])
  assert.equal(calls[1]?.maxCostUsd,0.65)
  assert.equal((task?.result?.report as {content:string}).content,'OK, JSON legível.')
  assert.equal((task?.result?.execution as {costUsd:number}).costUsd,0.2)
  assert.ok((task?.result?.criteria as Array<{status:string}>).every(item=>item.status==='failed'))
})

test('falha de formato ou orçamento preserva relatório e uso conhecido sem repetir inspeção', async () => {
  for (const scenario of ['invalid-format', 'no-budget'] as const) {
    const calls: string[] = []
    const runtime: AgentRuntimePort = { async run(input) {
      calls.push(input.purpose!)
      return { engine:'anthropic-claude-agent-sdk', sdkVersion:'test', authSource:'oauth-login', sessionId:`session-${calls.length}`, model:'test',
        output: input.purpose === 'verification' ? '[]' : 'Relatório preservado.',
        durationMs:1, turns:1, usage:{inputTokens:1,outputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:0,estimatedCostUsd:scenario === 'no-budget' ? 0.75 : 0.1}, permissionDenials:0, events:[] }
    } }
    const request = await fixture(); request.acceptanceCriteria = [criterion]; request.budget.maxCostUsd = 0.75
    const store = new InMemoryTaskStore(); const validator = await ContractValidator.create(root)
    await new TaskManager(store,validator,new PermittingAuthorityProvider()).submit(request)
    const worker = new TaskWorker(`worker-${scenario}`,store,validator,new AgentAssistedContractInspectionExecutor(runtime))
    const task = await worker.runOnce()
    assert.equal(task?.status,'failed')
    assert.equal((task?.result?.report as {content:string}).content,'Relatório preservado.')
    assert.equal((task?.result?.execution as {costUsd:number}).costUsd,scenario === 'no-budget' ? 0.75 : 0.2)
    assert.equal(calls.length,scenario === 'no-budget' ? 1 : 2)
    assert.equal(await worker.runOnce(),null)
  }
})
