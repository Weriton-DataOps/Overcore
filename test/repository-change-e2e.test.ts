import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { executionDetail, executionSummary } from '../src/application/execution-view.js'
import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { RepositoryChangeWorkbench } from '../src/application/repository-change-executor.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { sha256 } from '../src/domain/fingerprint.js'
import type { JsonObject, TaskDraft, TaskRequest } from '../src/domain/types.js'
import { createLocalServer } from '../src/infrastructure/http/local-server.js'
import type { RepositoryEditInput, RepositoryEditOutcome, RepositoryEditor } from '../src/ports/repository-editor.js'
import { InMemoryTaskStore } from '../src/testing/in-memory-task-store.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'

const root = process.cwd()
const exec = promisify(execFile)
const EXECUTOR_ID = 'overcore-repository-change-v1'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true })
  return stdout.trim()
}

async function gitExit(cwd: string, ...args: string[]): Promise<number> {
  return exec('git', args, { cwd, windowsHide: true }).then(() => 0, (error: { code?: number }) => error.code ?? 1)
}

/**
 * Repo descartável com um hook post-checkout que deixa marca no disco.
 *
 * O controle prova que o hook dispara num checkout comum; depois disso,
 * qualquer marca nova só pode ter vindo da bancada.
 */
async function disposableRepository(directory: string) {
  const repository = join(directory, 'repo')
  const hooks = join(directory, 'hooks')
  const marker = join(directory, 'hook-fired.txt')
  await mkdir(join(repository, 'src'), { recursive: true })
  await mkdir(hooks)
  await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\necho fired >> "${marker.replaceAll('\\', '/')}"\n`, { mode: 0o755 })
  await git(directory, 'init', '-q', '-b', 'main', repository)
  await git(repository, 'config', 'user.name', 'Overcore E2E')
  await git(repository, 'config', 'user.email', 'e2e@overcore.invalid')
  await git(repository, 'config', 'commit.gpgsign', 'false')
  await git(repository, 'config', 'core.hooksPath', hooks.replaceAll('\\', '/'))
  await writeFile(join(repository, 'src', 'app.mjs'), 'export const answer = 41\n', 'utf8')
  // A verificação escreve no disco de propósito: o commit publicado precisa
  // ser o tree medido antes dela, sem esse arquivo.
  await writeFile(join(repository, 'check.mjs'), [
    "import { readdirSync, writeFileSync } from 'node:fs'",
    "const features = readdirSync('src').filter((name) => name.startsWith('feature-'))",
    "writeFileSync('verification-output.txt', features.join('\\n'))",
    "if (features.length === 0) { console.error('nenhuma feature em src/'); process.exit(3) }",
    "console.log(`verificação ok: ${features.join(', ')}`)",
    ''
  ].join('\n'), 'utf8')
  await git(repository, 'add', '-A')
  await git(repository, 'commit', '-q', '-m', 'base')
  const baseCommit = await git(repository, 'rev-parse', 'HEAD')
  await git(repository, 'checkout', '-q', '--detach', 'HEAD')
  await git(repository, 'checkout', '-q', 'main')
  assert.ok(existsSync(marker), 'controle: o hook do repositório dispara num checkout comum')
  await rm(marker)
  return { repository, baseCommit, marker, repositoryUri: pathToFileURL(repository).href }
}

function repositoryRequest(repositoryUri: string, baseCommit: string, suffix: string, targetBranch: string): TaskRequest {
  const ref = `ref-repository-${suffix}`
  return {
    contractVersion: '1.0',
    requestId: `request-repository-change-${suffix}`,
    idempotencyKey: `repository-change-execution-${suffix}`,
    createdAt: '2026-10-22T12:00:00.000Z',
    preflight: {
      draftId: `draft-repository-change-${suffix}`,
      draftRevision: 1,
      draftFingerprint: { algorithm: 'sha256-jcs-v1', value: sha256(`draft-${suffix}`) },
      readinessReportId: `readiness-repository-change-${suffix}`
    },
    client: { id: 'client-overcore-e2e', kind: 'automation' },
    objective: `Adicionar a feature ${suffix} na repo descartável.`,
    priority: 'normal',
    context: {
      references: [{ refId: ref, uri: repositoryUri, kind: 'repository', sensitivity: 'internal' }],
      assumptions: []
    },
    constraints: [{ id: `constraint-scope-${suffix}`, kind: 'quality', description: 'Somente src/ pode mudar.' }],
    authority: {
      mode: 'proceed-within-scope',
      grants: [{
        resourceRef: ref,
        operations: ['repository.read', 'repository.worktree.modify', 'repository.branch.create', 'process.execute']
      }],
      expansionBoundaries: [
        'destructive', 'irreversible', 'financial', 'privilege-expansion', 'external-publication', 'secret-access'
      ]
    },
    acceptanceCriteria: [{
      id: `criterion-branch-${suffix}`,
      description: 'O branch novo contém a feature e a verificação declarada passou.',
      verification: { method: 'test', expected: 'node check.mjs termina com código 0.' }
    }],
    budget: { maxDurationMs: 300_000, maxAttempts: 1, maxParallelism: 1 },
    expectedOutput: { kind: 'repository-change', mediaType: 'text/x-diff', destinationRef: ref },
    execution: {
      kind: 'repository-change',
      resourceRef: ref,
      baseCommit,
      targetBranch,
      instructions: `Criar src/feature-${suffix}.mjs exportando a feature ${suffix}.`,
      pathScope: { include: ['src/**'], exclude: ['**/*.pem', '.env*'] },
      limits: { maxFilesChanged: 3, maxDiffBytes: 20_000 },
      verification: { argv: [process.execPath, 'check.mjs'], timeoutMs: 60_000, expectedExitCode: 0 }
    }
  }
}

/** O que o Omni manda de verdade: um TaskDraft cujo hint o Preflight congela em TaskRequest.execution. */
function repositoryDraft(repositoryUri: string, baseCommit: string, suffix: string, targetBranch: string): TaskDraft {
  const ref = `ref-repository-${suffix}`
  return {
    contractVersion: '1.0',
    draftId: `draft-repository-api-${suffix}`,
    revision: 1,
    idempotencyKey: `prepare-repository-api-${suffix}`,
    executionIdempotencyKey: `execute-repository-api-${suffix}`,
    createdAt: '2026-10-22T12:00:00.000Z',
    client: { id: 'client-omni', kind: 'automation' },
    objective: `Adicionar a feature ${suffix} na repo descartável.`,
    context: {
      references: [{ refId: ref, uri: repositoryUri, kind: 'repository', sensitivity: 'internal' }],
      assumptions: []
    },
    knownConstraints: [{ id: `constraint-scope-${suffix}`, kind: 'quality', description: 'Somente src/ pode mudar.' }],
    knownAcceptanceCriteria: [{
      id: `criterion-branch-${suffix}`,
      description: 'O branch novo contém a feature e node check.mjs termina com código 0.',
      verificationHint: 'test'
    }],
    discoveryAuthority: {
      mode: 'inspect-only',
      grants: [{ resourceRef: ref, operations: [{ name: 'repository.read', effect: 'read' }] }]
    },
    availableExecutionAuthority: {
      mode: 'proceed-within-scope',
      grants: [{
        resourceRef: ref,
        operations: ['repository.read', 'repository.worktree.modify', 'repository.branch.create', 'process.execute']
      }],
      expansionBoundaries: [
        'destructive', 'irreversible', 'financial', 'privilege-expansion', 'external-publication', 'secret-access'
      ]
    },
    executionBudget: {
      source: {
        kind: 'policy-default',
        sourceId: 'policy-repository-change-e2e',
        sourceVersion: '1.0',
        sourceDigest: sha256('policy-repository-change-e2e')
      },
      limits: { maxDurationMs: 300_000, maxAttempts: 1, maxParallelism: 1 }
    },
    decisionAnswers: [],
    preflightBudget: { maxDurationMs: 60_000, maxInspectionOperations: 1 },
    executionHints: {
      priority: 'normal',
      expectedOutputKind: 'repository-change',
      repositoryChange: {
        kind: 'repository-change',
        resourceRef: ref,
        baseCommit,
        targetBranch,
        instructions: `Criar src/feature-${suffix}.mjs exportando a feature ${suffix}.`,
        pathScope: { include: ['src/**'], exclude: ['**/*.pem', '.env*'] },
        limits: { maxFilesChanged: 3, maxDiffBytes: 20_000 },
        verification: { argv: [process.execPath, 'check.mjs'], timeoutMs: 60_000, expectedExitCode: 0 }
      }
    }
  }
}

/** Duas execuções só se encontram aqui se estiverem editando ao mesmo tempo. */
class Barrier {
  private arrived = 0
  private release: () => void = () => undefined
  private readonly opened = new Promise<void>((resolve) => { this.release = resolve })

  constructor(private readonly parties: number) {}

  async arrive(): Promise<void> {
    this.arrived += 1
    if (this.arrived >= this.parties) this.release()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      this.opened,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('A outra execução nunca chegou: elas não rodaram ao mesmo tempo.')), 20_000)
      })
    ]).finally(() => clearTimeout(timer))
  }
}

/** Editor determinístico: escreve um arquivo no escopo e prova que o guarda nega o resto. */
class ScriptedEditor implements RepositoryEditor {
  readonly calls: RepositoryEditInput[] = []
  active = 0
  maxActive = 0

  constructor(private readonly barrier?: Barrier) {}

  async edit(input: RepositoryEditInput): Promise<RepositoryEditOutcome> {
    this.calls.push(input)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      await this.barrier?.arrive()
      const suffix = /feature (\S+)/.exec(input.objective)?.[1] ?? 'sem-nome'
      const path = `src/feature-${suffix}.mjs`
      const decision = await input.checkPath(path)
      assert.equal(decision.allowed, true, `o guarda precisa liberar ${path}`)
      for (const forbidden of ['.git/config', 'check.mjs', '../fora.txt', '.env.local']) {
        assert.equal((await input.checkPath(forbidden)).allowed, false, `o guarda precisa negar ${forbidden}`)
      }
      await mkdir(dirname(join(input.worktreePath, path)), { recursive: true })
      await writeFile(join(input.worktreePath, path), `export const feature = '${suffix}'\n`, 'utf8')
      return { report: `Criei \`${path}\`.`, tokens: 0, costUsd: 0 }
    } finally {
      this.active -= 1
    }
  }
}

async function bench(directory: string, editor: RepositoryEditor) {
  const validator = await ContractValidator.create(root)
  const store = new InMemoryTaskStore()
  const manager = new TaskManager(store, validator, new PermittingAuthorityProvider())
  const worktreeRoot = join(directory, 'worktrees')
  const workbench = new RepositoryChangeWorkbench(editor, { worktreeRoot })
  const worker = (id: string) => new TaskWorker(
    id, store, validator, new ReadOnlyContractInspectionExecutor(), undefined, undefined, undefined, workbench
  )
  return { validator, store, manager, worktreeRoot, worker }
}

async function assertOwnerUntouched(repository: string, baseCommit: string, worktreeRoot: string, marker: string) {
  assert.equal(await git(repository, 'status', '--porcelain'), '', 'a working tree do dono continua limpa')
  assert.equal(await git(repository, 'rev-parse', 'HEAD'), baseCommit, 'o HEAD do dono não se move')
  assert.equal(await git(repository, 'symbolic-ref', '--short', 'HEAD'), 'main')
  const worktrees = (await git(repository, 'worktree', 'list', '--porcelain')).split('\n').filter((line) => line.startsWith('worktree '))
  assert.equal(worktrees.length, 1, 'nenhuma worktree da bancada sobra registrada')
  assert.deepEqual(existsSync(worktreeRoot) ? await readdir(worktreeRoot) : [], [], 'nenhuma bancada sobra no disco')
  assert.equal(existsSync(marker), false, 'nenhum hook do repositório rodou durante a execução')
}

test('e2e: pedido do Omni vira branch verificado sem tocar a working tree do dono, visível pela API de leitura', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-repo-e2e-'))
  try {
    const { repository, baseCommit, marker, repositoryUri } = await disposableRepository(directory)
    const editor = new ScriptedEditor()
    const { store, manager, worktreeRoot, worker } = await bench(directory, editor)
    const branch = 'overcore/e2e-caminho-feliz'

    const scheduled = await manager.submit(repositoryRequest(repositoryUri, baseCommit, 'alfa', branch))
    assert.equal(scheduled.status, 'running', JSON.stringify(scheduled.result?.inputRequired ?? scheduled.reconciliation))
    assert.equal([...store.outbox.values()][0]?.kind, 'execute-repository-change')
    const running = executionSummary(scheduled)
    assert.deepEqual(running.activeExecutors, [EXECUTOR_ID])
    assert.match(String(running.currentStep), /worktree/)
    assert.deepEqual(running.repository, { uri: repositoryUri, baseCommit, targetBranch: branch })

    const completed = await worker('worker-e2e-1').runOnce()
    assert.equal(completed?.status, 'succeeded', JSON.stringify(completed?.result))
    assert.equal(editor.calls.length, 1)
    assert.notEqual(editor.calls[0]?.worktreePath, repository, 'o editor nunca recebe o repositório do dono')

    const commit = await git(repository, 'rev-parse', `refs/heads/${branch}`)
    assert.equal(await git(repository, 'rev-parse', `${commit}^`), baseCommit, 'pai único igual ao commit base')
    assert.equal(await gitExit(repository, 'rev-parse', '--verify', '--quiet', `${commit}^2`), 1, 'commit sem segundo pai')
    assert.match(await git(repository, 'log', '-1', '--format=%B', commit), /^Overcore-Effect-Key: repository-change:/m)
    assert.deepEqual((await git(repository, 'diff-tree', '-r', '--name-only', '--no-commit-id', baseCommit, commit)).split('\n'),
      ['src/feature-alfa.mjs'], 'o commit contém só a mudança medida, sem a saída da verificação')
    await assertOwnerUntouched(repository, baseCommit, worktreeRoot, marker)

    const detail = executionDetail(completed!)
    assert.equal(detail.state, 'succeeded')
    assert.equal(detail.terminal, true)
    assert.equal(detail.needsAnswer, false)
    assert.deepEqual(detail.activeExecutors, [])
    assert.match(String(detail.resultSummary), new RegExp(`${branch} criado em ${commit.slice(0, 12)}`))
    assert.deepEqual((detail.evidence as JsonObject[]).map((item) => item.kind), ['inspection', 'test-result', 'state-readback'])
    const report = (detail.result as JsonObject).report as JsonObject
    assert.match(String(report.content), /verificação ok: feature-alfa\.mjs/)
    assert.equal(((detail.result as JsonObject).effects as JsonObject[])[0]?.status, 'confirmed')
    assert.equal(await worker('worker-e2e-1').runOnce(), null, 'nenhuma mensagem sobra na outbox')

    const token = 'token-e2e-somente-teste-0001'
    const server = createLocalServer(manager, worker('worker-e2e-http'), token)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const base = `http://127.0.0.1:${address.port}`
      const auth = { headers: { authorization: `Bearer ${token}` } }
      assert.equal((await fetch(`${base}/v1/executions`)).status, 401)
      const list = await fetch(`${base}/v1/executions?state=succeeded,blocked&limit=10`, auth)
      assert.equal(list.status, 200)
      const listed = await list.json() as JsonObject
      assert.equal(listed.viewVersion, 1)
      assert.equal(listed.limit, 10)
      const rows = listed.executions as JsonObject[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.executionId, completed!.taskId)
      assert.equal(rows[0]?.report, undefined, 'a listagem não carrega o relatório')
      const one = await fetch(`${base}/v1/executions/${encodeURIComponent(completed!.taskId)}`, auth)
      assert.equal(one.status, 200)
      const body = await one.json() as JsonObject
      assert.equal((body.execution as JsonObject).executionId, completed!.taskId)
      assert.ok(Array.isArray((body.execution as JsonObject).transitions))
      assert.equal((await fetch(`${base}/v1/executions/task-que-nao-existe`, auth)).status, 404)
      const badState = await fetch(`${base}/v1/executions?state=inventado`, auth)
      assert.equal(badState.status, 400)
      assert.equal((await badState.json() as JsonObject).error, 'invalid-request', 'erro de consulta tem código estável')
      assert.equal((await fetch(`${base}/v1/executions?limit=0`, auth)).status, 400)
      const none = await fetch(`${base}/v1/executions?state=running`, auth).then((response) => response.json()) as JsonObject
      assert.deepEqual(none.executions, [])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('e2e pela API: o Omni manda o TaskDraft por /v1/preflight, admite e acompanha até o branch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-repo-api-'))
  try {
    const { repository, baseCommit, marker, repositoryUri } = await disposableRepository(directory)
    const editor = new ScriptedEditor()
    const { manager, worktreeRoot, worker } = await bench(directory, editor)
    const branch = 'overcore/e2e-pela-api'
    const token = 'token-e2e-somente-teste-0002'
    const server = createLocalServer(manager, worker('worker-e2e-api'), token)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const base = `http://127.0.0.1:${address.port}`
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const post = (path: string, body?: unknown) => fetch(`${base}${path}`, {
        method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })

      const badBranch = await post('/v1/preflight', { draft: repositoryDraft(repositoryUri, baseCommit, 'ruim', 'overcore/curto') })
      assert.equal(badBranch.status, 400, 'branch fora da regra morre no contrato do draft')
      assert.equal((await badBranch.json() as JsonObject).error, 'ContractValidationError')

      const draft = repositoryDraft(repositoryUri, baseCommit, 'api', branch)
      const prepared = await post('/v1/preflight', { draft })
      assert.equal(prepared.status, 200)
      const report = await prepared.json() as JsonObject
      assert.equal(report.status, 'ready', JSON.stringify(report.readinessChecks))
      const request = report.preparedRequest as TaskRequest
      assert.deepEqual(request.execution, (draft.executionHints as JsonObject).repositoryChange, 'o hint vira execution sem reinterpretação')
      assert.deepEqual(request.expectedOutput, { kind: 'repository-change', destinationRef: 'ref-repository-api' })

      const admitted = await post(`/v1/preflight/${encodeURIComponent(String(report.reportId))}/admit`)
      assert.equal(admitted.status, 202)
      const admission = await admitted.json() as JsonObject
      assert.equal(admission.status, 'running', JSON.stringify(admission))
      const taskId = String(admission.taskId)

      const worked = await post('/v1/work-once')
      assert.equal(worked.status, 200)
      const work = await worked.json() as JsonObject
      assert.equal(work.taskId, taskId)
      assert.equal(work.status, 'succeeded', JSON.stringify(work))

      const detail = await fetch(`${base}/v1/executions/${encodeURIComponent(taskId)}`, { headers })
      assert.equal(detail.status, 200)
      const execution = (await detail.json() as JsonObject).execution as JsonObject
      assert.equal(execution.state, 'succeeded')
      assert.deepEqual(execution.repository, { uri: repositoryUri, baseCommit, targetBranch: branch })
      const commit = await git(repository, 'rev-parse', `refs/heads/${branch}`)
      assert.match(String(execution.resultSummary), new RegExp(`${branch} criado em ${commit.slice(0, 12)}`))
      assert.deepEqual((await git(repository, 'diff-tree', '-r', '--name-only', '--no-commit-id', baseCommit, commit)).split('\n'),
        ['src/feature-api.mjs'])

      const again = await post(`/v1/preflight/${encodeURIComponent(String(report.reportId))}/admit`)
      assert.equal(again.status, 202, 'admitir de novo é idempotente')
      assert.equal((await again.json() as JsonObject).taskId, taskId)
      assert.equal(editor.calls.length, 1, 'a readmissão não edita outra vez')
      await assertOwnerUntouched(repository, baseCommit, worktreeRoot, marker)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('e2e: branch alheio bloqueia pedindo gente; liberar e retomar conclui, cancelar encerra sem tocar no repo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-repo-block-'))
  try {
    const { repository, baseCommit, marker, repositoryUri } = await disposableRepository(directory)
    const editor = new ScriptedEditor()
    const { store, manager, worktreeRoot, worker } = await bench(directory, editor)
    const branch = 'overcore/e2e-branch-ocupado'
    await git(repository, 'branch', branch, baseCommit)

    const blocked = await manager.submit(repositoryRequest(repositoryUri, baseCommit, 'beta', branch))
    assert.equal(blocked.status, 'blocked')
    assert.equal(store.authorizations.size, 0, 'o disco responde antes de gastar autorização do Omni')
    assert.equal(store.outbox.size, 0)
    const view = executionSummary(blocked)
    assert.equal(view.needsAnswer, true)
    assert.equal(view.currentStep, 'parada, aguardando resposta')
    const block = view.block as JsonObject
    assert.equal(block.code, 'block-repository-branch-exists')
    assert.equal(block.kind, 'decision')
    assert.match(String(block.question), new RegExp(branch))
    assert.deepEqual((block.options as JsonObject[]).map((option) => option.id), ['option-free-branch-and-resume', 'option-cancel-task'])
    assert.deepEqual(block.answer, {
      resume: `POST /v1/tasks/${encodeURIComponent(blocked.taskId)}/resume`,
      replace: null,
      cancel: `POST /v1/tasks/${encodeURIComponent(blocked.taskId)}/cancel`
    })

    const stillBlocked = await manager.resume(blocked.taskId)
    assert.equal(stillBlocked?.status, 'blocked', 'retomar sem liberar o branch bloqueia de novo')
    assert.equal(await git(repository, 'rev-parse', `refs/heads/${branch}`), baseCommit, 'o branch alheio não foi sobrescrito')

    await git(repository, 'branch', '-D', branch)
    const resumed = await manager.resume(blocked.taskId)
    assert.equal(resumed?.status, 'running', JSON.stringify(resumed?.result?.inputRequired))
    const completed = await worker('worker-e2e-block').runOnce()
    assert.equal(completed?.status, 'succeeded', JSON.stringify(completed?.result))
    const commit = await git(repository, 'rev-parse', `refs/heads/${branch}`)
    assert.equal(await git(repository, 'rev-parse', `${commit}^`), baseCommit)

    const otherBranch = 'overcore/e2e-branch-cancelado'
    await git(repository, 'branch', otherBranch, baseCommit)
    const second = await manager.submit(repositoryRequest(repositoryUri, baseCommit, 'gama', otherBranch))
    assert.equal(second.status, 'blocked')
    const cancelled = await manager.cancel(second.taskId)
    assert.equal(cancelled?.status, 'cancelled')
    assert.equal(executionSummary(cancelled!).needsAnswer, false)
    assert.equal(await git(repository, 'rev-parse', `refs/heads/${otherBranch}`), baseCommit, 'cancelar não toca no branch alheio')
    assert.equal(editor.calls.length, 1, 'o editor só rodou para a tarefa retomada')
    await assertOwnerUntouched(repository, baseCommit, worktreeRoot, marker)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('e2e: cancelar antes do worker reivindicar reconcilia sem editar nem criar branch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-repo-cancel-'))
  try {
    const { repository, baseCommit, marker, repositoryUri } = await disposableRepository(directory)
    const editor = new ScriptedEditor()
    const { manager, worktreeRoot, worker } = await bench(directory, editor)
    const branch = 'overcore/e2e-cancelado-cedo'

    const scheduled = await manager.submit(repositoryRequest(repositoryUri, baseCommit, 'delta', branch))
    assert.equal(scheduled.status, 'running')
    const requested = await manager.cancel(scheduled.taskId)
    assert.ok(['cancelling', 'cancelled'].includes(String(requested?.status)), String(requested?.status))
    await worker('worker-e2e-cancel').runOnce()
    const final = await manager.get(scheduled.taskId)
    assert.equal(final?.status, 'cancelled', JSON.stringify(final?.result))
    assert.equal(editor.calls.length, 0, 'nenhuma edição depois do cancelamento')
    assert.equal(await gitExit(repository, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`), 1, 'nenhum branch criado')
    await assertOwnerUntouched(repository, baseCommit, worktreeRoot, marker)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('e2e: duas execuções no mesmo repo correm ao mesmo tempo em worktrees separadas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overcore-repo-parallel-'))
  try {
    const { repository, baseCommit, marker, repositoryUri } = await disposableRepository(directory)
    const editor = new ScriptedEditor(new Barrier(2))
    const { manager, worktreeRoot, worker } = await bench(directory, editor)

    const first = await manager.submit(repositoryRequest(repositoryUri, baseCommit, 'eta', 'overcore/e2e-paralelo-eta'))
    const second = await manager.submit(repositoryRequest(repositoryUri, baseCommit, 'teta', 'overcore/e2e-paralelo-teta'))
    assert.equal(first.status, 'running')
    assert.equal(second.status, 'running')

    const results = await Promise.all([worker('worker-e2e-slot-1').runOnce(), worker('worker-e2e-slot-2').runOnce()])
    assert.deepEqual(results.map((task) => task?.status), ['succeeded', 'succeeded'], JSON.stringify(results.map((task) => task?.result)))
    assert.deepEqual(new Set(results.map((task) => task?.taskId)), new Set([first.taskId, second.taskId]))
    assert.equal(editor.maxActive, 2, 'as duas edições estiveram ativas ao mesmo tempo')
    assert.notEqual(editor.calls[0]?.worktreePath, editor.calls[1]?.worktreePath, 'cada execução tem sua worktree')

    for (const suffix of ['eta', 'teta']) {
      const commit = await git(repository, 'rev-parse', `refs/heads/overcore/e2e-paralelo-${suffix}`)
      assert.equal(await git(repository, 'rev-parse', `${commit}^`), baseCommit)
      assert.deepEqual((await git(repository, 'diff-tree', '-r', '--name-only', '--no-commit-id', baseCommit, commit)).split('\n'),
        [`src/feature-${suffix}.mjs`], `o branch ${suffix} não carrega a mudança da outra execução`)
    }
    await assertOwnerUntouched(repository, baseCommit, worktreeRoot, marker)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
