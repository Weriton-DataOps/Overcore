// A fechadura da mudança de repositório (ADR-022) no motor SQLite da casa: sem autoridade, o pedido
// para antes de plano, autorização ou outbox, e o worker não tem o que reivindicar, então nenhum
// editor é chamado e nenhuma worktree nasce. O controle positivo mostra que o mesmo pedido, com
// autoridade, chega à outbox no mesmo banco: quem trava é a fechadura, não o motor.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { after, test } from 'node:test'

import { permittingDecision } from '../src/application/authorization.js'
import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { RepositoryChangeWorkbench } from '../src/application/repository-change-executor.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { fingerprint, sha256 } from '../src/domain/fingerprint.js'
import type { JsonObject, TaskRequest } from '../src/domain/types.js'
import { SqliteTaskStore } from '../src/infrastructure/database/sqlite/sqlite-task-store.js'
import type { AuthorityProvider } from '../src/ports/task-store.js'
import type { RepositoryEditInput, RepositoryEditOutcome, RepositoryEditor } from '../src/ports/repository-editor.js'
import { PermittingAuthorityProvider } from '../src/testing/permitting-authority-provider.js'
import { bancoMigrado, contar } from './support/sqlite-fixtures.js'

const root = process.cwd()
const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true })
  return stdout.trim()
}

/** Repo descartável de verdade, sem hooks: o manager confere repositório e commit base antes da autoridade. */
async function repoDescartavel(pasta: string): Promise<{ repositoryUri: string; baseCommit: string }> {
  const repo = join(pasta, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await git(pasta, 'init', '-q', '-b', 'main', repo)
  await git(repo, 'config', 'user.name', 'Overcore Fechadura')
  await git(repo, 'config', 'user.email', 'fechadura@overcore.invalid')
  await git(repo, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(repo, 'src', 'app.mjs'), 'export const answer = 41\n', 'utf8')
  await git(repo, 'add', '-A')
  await git(repo, '-c', 'core.hooksPath=' + join(pasta, 'sem-hooks').replaceAll('\\', '/'), 'commit', '-q', '-m', 'base')
  return { repositoryUri: pathToFileURL(repo).href, baseCommit: await git(repo, 'rev-parse', 'HEAD') }
}
const pastas: string[] = []
after(async () => { await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true }))) })

/** Editor que só registra: se for chamado, a fechadura falhou. */
class EditorVigiado implements RepositoryEditor {
  readonly calls: RepositoryEditInput[] = []
  async edit(input: RepositoryEditInput): Promise<RepositoryEditOutcome> {
    this.calls.push(input)
    return { report: 'não devia ter chegado aqui', tokens: 0, costUsd: 0 }
  }
}

/** Omni que nega tudo, com a decisão bem formada e a impressão refeita. */
const omniQueNega: AuthorityProvider = {
  async evaluate(request: JsonObject) {
    const decision = permittingDecision(request, new Date())
    decision.outcome = 'deny'
    decision.actionDecisions = (decision.actionDecisions as JsonObject[]).map((item) => ({
      ...item, outcome: 'deny', reasonCode: 'outside-delegated-authority', requiredControls: []
    }))
    delete decision.decisionFingerprint
    decision.decisionFingerprint = fingerprint(decision)
    return decision
  }
}

const OPERACOES_DE_REPOSITORIO = ['repository.read', 'repository.worktree.modify', 'repository.branch.create', 'process.execute']

function pedido(repositoryUri: string, baseCommit: string, sufixo: string, operations: string[]): TaskRequest {
  const ref = `ref-repository-${sufixo}`
  return {
    contractVersion: '1.0',
    requestId: `request-fechadura-${sufixo}`,
    idempotencyKey: `fechadura-sqlite-${sufixo}`,
    createdAt: '2026-11-05T12:00:00.000Z',
    preflight: {
      draftId: `draft-fechadura-${sufixo}`,
      draftRevision: 1,
      draftFingerprint: { algorithm: 'sha256-jcs-v1', value: sha256(`draft-${sufixo}`) },
      readinessReportId: `readiness-fechadura-${sufixo}`
    },
    client: { id: 'client-overcore-fechadura', kind: 'automation' },
    objective: `Adicionar a feature ${sufixo} na repo descartável.`,
    priority: 'normal',
    context: {
      references: [{ refId: ref, uri: repositoryUri, kind: 'repository', sensitivity: 'internal' }],
      assumptions: []
    },
    constraints: [{ id: `constraint-scope-${sufixo}`, kind: 'quality', description: 'Somente src/ pode mudar.' }],
    authority: {
      mode: 'proceed-within-scope',
      grants: [{ resourceRef: ref, operations }],
      expansionBoundaries: ['destructive', 'irreversible', 'financial', 'privilege-expansion', 'external-publication', 'secret-access']
    },
    acceptanceCriteria: [{
      id: `criterion-branch-${sufixo}`,
      description: 'O branch novo contém a feature.',
      verification: { method: 'test', expected: 'node check.mjs termina com código 0.' }
    }],
    budget: { maxDurationMs: 300_000, maxAttempts: 1, maxParallelism: 1 },
    expectedOutput: { kind: 'repository-change', mediaType: 'text/x-diff', destinationRef: ref },
    execution: {
      kind: 'repository-change',
      resourceRef: ref,
      baseCommit,
      targetBranch: `overcore/fechadura-${sufixo}`,
      instructions: `Criar src/feature-${sufixo}.mjs exportando a feature ${sufixo}.`,
      pathScope: { include: ['src/**'], exclude: ['**/*.pem', '.env*'] },
      limits: { maxFilesChanged: 3, maxDiffBytes: 20_000 }
    }
  }
}

async function bancada(authority: AuthorityProvider) {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-fechadura-'))
  pastas.push(pasta)
  const arquivo = await bancoMigrado()
  const validator = await ContractValidator.create(root)
  const store = new SqliteTaskStore(arquivo, 'maquina-teste')
  const manager = new TaskManager(store, validator, authority)
  const editor = new EditorVigiado()
  const worktreeRoot = join(pasta, 'worktrees')
  const worker = new TaskWorker('worker-fechadura', store, validator, new ReadOnlyContractInspectionExecutor(),
    undefined, undefined, undefined, new RepositoryChangeWorkbench(editor, { worktreeRoot }))
  return { arquivo, manager, editor, worktreeRoot, worker, ...(await repoDescartavel(pasta)) }
}

async function assertNadaAndou(b: Awaited<ReturnType<typeof bancada>>): Promise<void> {
  assert.equal(contar(b.arquivo, 'overcore_task_outbox'), 0, 'nenhum executor recebe trabalho')
  assert.equal(await b.worker.runOnce(), null, 'o worker não tem o que reivindicar')
  assert.equal(b.editor.calls.length, 0, 'o editor nunca é chamado')
  assert.equal(existsSync(b.worktreeRoot), false, 'nenhuma worktree nasce no disco')
}

test('SQLite: mudança de repositório sem a autoridade de repositório no pedido bloqueia antes de plano, autorização ou outbox', async () => {
  const b = await bancada(new PermittingAuthorityProvider())
  const task = await b.manager.submit(pedido(b.repositoryUri, b.baseCommit, 'sem-grant', ['repository.read']))
  assert.equal(task.status, 'blocked')
  assert.equal((task.result?.inputRequired as JsonObject | undefined)?.code, 'block-repository-request-invalid')
  assert.equal(contar(b.arquivo, 'overcore_task_plans'), 0, 'nenhum plano nasce por omissão')
  assert.equal(contar(b.arquivo, 'overcore_task_authorizations'), 0, 'o Omni não é consultado para um plano inexistente')
  await assertNadaAndou(b)
})

test('SQLite: mudança de repositório que o Omni nega fica bloqueada, sem outbox, editor nem worktree', async () => {
  const b = await bancada(omniQueNega)
  const task = await b.manager.submit(pedido(b.repositoryUri, b.baseCommit, 'negada', OPERACOES_DE_REPOSITORIO))
  assert.equal(task.status, 'blocked')
  assert.equal((task.result?.inputRequired as JsonObject | undefined)?.code, 'block-authorization-denied')
  await assertNadaAndou(b)
})

test('SQLite, controle: o mesmo pedido com autoridade chega à outbox; quem trava é a fechadura, não o motor', async () => {
  const b = await bancada(new PermittingAuthorityProvider())
  const task = await b.manager.submit(pedido(b.repositoryUri, b.baseCommit, 'liberada', OPERACOES_DE_REPOSITORIO))
  assert.equal(task.status, 'running', JSON.stringify(task.result?.inputRequired ?? task.reconciliation))
  assert.equal(contar(b.arquivo, 'overcore_task_outbox'), 1)
})
