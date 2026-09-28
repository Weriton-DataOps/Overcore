import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { executionStrategyFor, UnsupportedExecutionKindError } from '../src/application/execution-strategy.js'
import { TaskManager } from '../src/application/task-manager.js'
import { ContractValidator } from '../src/contracts/validator.js'
import type { JsonObject, RepositoryChangeExecution, TaskRequest } from '../src/domain/types.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()

function repositoryChange(): RepositoryChangeExecution {
  return {
    kind: 'repository-change',
    resourceRef: 'ref-overcore-repository',
    baseCommit: '057b0eb1f3c62be9d9f566cd3c9ae2f22bd51f86',
    targetBranch: 'overcore/task-fatia-1-exemplo',
    instructions: 'Corrigir o teste que falha em test/a.test.ts sem alterar outros arquivos.',
    pathScope: { include: ['src/**', 'test/**'], exclude: ['**/*.pem', '.env*'] },
    limits: { maxFilesChanged: 5, maxDiffBytes: 20000 },
    verification: { argv: ['npm.cmd', 'test'], timeoutMs: 600000, expectedExitCode: 0 }
  }
}

async function requestWith(execution: unknown): Promise<TaskRequest> {
  const path = join(root, 'contratos', 'exemplos', 'task-request-inspecao-executavel.json')
  const request = JSON.parse(await readFile(path, 'utf8')) as TaskRequest
  request.context.references[0]!.uri = pathToFileURL(root).href
  ;(request as JsonObject).execution = execution as JsonObject
  return request
}

test('contrato aceita mudança de repositório completa e sem verificação opcional', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  validator.taskRequest(await requestWith(repositoryChange()))
  const withoutVerification = repositoryChange()
  delete withoutVerification.verification
  validator.taskRequest(await requestWith(withoutVerification))
})

test('contrato recusa mudança de repositório fora das fronteiras da ADR-022', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const mutations: Array<[string, (execution: JsonObject) => void]> = [
    ['branch sem prefixo reservado', (e) => { e.targetBranch = 'feature/qualquer-coisa' }],
    ['branch com ..', (e) => { e.targetBranch = 'overcore/a..b-exemplo' }],
    ['branch terminando em .lock', (e) => { e.targetBranch = 'overcore/exemplo-ref.lock' }],
    ['commit abreviado', (e) => { e.baseCommit = '057b0eb' }],
    ['commit em maiúsculas', (e) => { e.baseCommit = '057B0EB1F3C62BE9D9F566CD3C9AE2F22BD51F86' }],
    ['escopo sem inclusão', (e) => { (e.pathScope as JsonObject).include = [] }],
    ['glob absoluto', (e) => { (e.pathScope as JsonObject).include = ['/etc/**'] }],
    ['glob com unidade', (e) => { (e.pathScope as JsonObject).include = ['C:/Windows/**'] }],
    ['glob que sobe', (e) => { (e.pathScope as JsonObject).include = ['src/../../**'] }],
    ['glob com barra invertida', (e) => { (e.pathScope as JsonObject).include = ['src\\**'] }],
    ['limite de arquivos zero', (e) => { (e.limits as JsonObject).maxFilesChanged = 0 }],
    ['verificação sem argv', (e) => { (e.verification as JsonObject).argv = [] }],
    ['argv com quebra de linha', (e) => { (e.verification as JsonObject).argv = ['npm.cmd', 'test\nrm -rf /'] }],
    ['verificação sem timeout', (e) => { delete (e.verification as JsonObject).timeoutMs }],
    ['campo desconhecido', (e) => { e.shell = true }],
    ['instrução vazia', (e) => { e.instructions = '' }]
  ]
  const base = await requestWith(repositoryChange())
  validator.taskRequest(base)
  for (const [label, mutate] of mutations) {
    const request = structuredClone(base) as JsonObject
    mutate(request.execution as JsonObject)
    assert.throws(() => validator.taskRequest(request), label)
  }
})

test('autorização aceita a classe local-code-execution no enum de efeitos', async () => {
  const schema = JSON.parse(await readFile(join(root, 'contratos', 'authorization-request.schema.json'), 'utf8')) as JsonObject
  assert.match(JSON.stringify(schema), /"local-code-execution"/)
})

test('estratégia é exaustiva e não herda inspeção para tipo sem executor', async () => {
  const inspection = await requestWith(undefined)
  delete (inspection as JsonObject).execution
  assert.equal(executionStrategyFor(inspection), 'inspection')
  assert.throws(
    () => executionStrategyFor({ ...inspection, execution: repositoryChange() }),
    (error: unknown) => error instanceof UnsupportedExecutionKindError && error.executionKind === 'repository-change'
  )
  assert.throws(
    () => executionStrategyFor({ ...inspection, execution: { kind: 'algo-futuro' } } as unknown as TaskRequest),
    (error: unknown) => error instanceof UnsupportedExecutionKindError && error.executionKind === 'algo-futuro'
  )
})

test('pedido de mudança de repositório bloqueia antes de plano, autorização ou outbox', async () => {
  const validator: ContractValidator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())

  const task = await manager.submit(await requestWith(repositoryChange()))

  assert.equal(task.status, 'blocked')
  assert.equal(task.result?.status, 'blocked')
  const inputRequired = task.result?.inputRequired as JsonObject | undefined
  assert.equal(inputRequired?.code, 'block-execution-capability-unavailable')
  assert.equal(store.plans.size, 0, 'nenhum plano de inspeção pode nascer por omissão')
  assert.equal(store.authorizations.size, 0, 'o Omni não é consultado para um plano inexistente')
  assert.equal(store.outbox.size, 0, 'nenhum executor recebe trabalho')
  validator.taskState(task.state)
})
