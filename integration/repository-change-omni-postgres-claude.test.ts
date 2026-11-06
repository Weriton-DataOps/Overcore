import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { ReadOnlyContractInspectionExecutor } from '../src/application/inspection-executor.js'
import { RepositoryChangeWorkbench } from '../src/application/repository-change-executor.js'
import { sanitizedEnvironment } from '../src/application/repository-git.js'
import { TaskManager } from '../src/application/task-manager.js'
import { TaskWorker } from '../src/application/task-worker.js'
import { ContractValidator } from '../src/contracts/validator.js'
import { sha256 } from '../src/domain/fingerprint.js'
import type { JsonObject, TaskRequest } from '../src/domain/types.js'
import { ClaudeRepositoryEditor } from '../src/infrastructure/agent-runtime/claude-repository-editor.js'
import { HttpAuthorityProvider } from '../src/infrastructure/authority/http-authority-provider.js'
import { createPostgresPool, migrate } from '../src/infrastructure/database/postgres.js'
import { PostgresTaskStore } from '../src/infrastructure/database/postgres-task-store.js'

const root = process.cwd()
const exec = promisify(execFile)
// A verificação roda sem shell, pelo mesmo argv que o TaskRequest congela.
const VERIFICATION = [process.execPath, '--test', 'test/sum.test.mjs']

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true })
  return stdout.trim()
}

// Mesmo ambiente da bancada: NODE_TEST_CONTEXT herdado deste runner faria o filho sair com 0.
async function exitCode(cwd: string, argv: string[]): Promise<number> {
  const [file, ...args] = argv
  return exec(file!, args, { cwd, env: sanitizedEnvironment(), windowsHide: true }).then(() => 0, (error: { code?: number }) => error.code ?? 1)
}

async function startOmni(repository: string, token: string): Promise<{ process: ChildProcessWithoutNullStreams, endpoint: URL }> {
  const child = spawn(process.execPath, [join(repository, 'adaptadores', 'overcore-authority-http.mjs')], {
    cwd: repository,
    env: { ...process.env, OMNI_AUTHORITY_PROVIDER_TOKEN: token, OMNI_AUTHORITY_PROVIDER_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const endpoint = await new Promise<URL>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Omni não iniciou: ${stderr}`)), 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.once('data', (chunk: string) => {
      clearTimeout(timeout)
      try {
        const ready = JSON.parse(chunk.trim()) as { status?: string, url?: string }
        if (ready.status !== 'ready' || typeof ready.url !== 'string') throw new Error('payload ready inválido')
        resolve(new URL(ready.url))
      } catch (error) { reject(error) }
    })
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Omni encerrou antes de iniciar (${String(code)}): ${stderr}`)) })
  })
  return { process: child, endpoint }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
}

/**
 * Repo descartável com um defeito conhecido: `sum` subtrai.
 *
 * O teste fica fora do escopo de escrita, então o único jeito de passar é
 * consertar `src/`. O hook post-checkout deixa marca se a bancada o disparar.
 */
async function defectiveRepository(directory: string) {
  const repository = join(directory, 'repo')
  const hooks = join(directory, 'hooks')
  const marker = join(directory, 'hook-fired.txt')
  await mkdir(join(repository, 'src'), { recursive: true })
  await mkdir(join(repository, 'test'))
  await mkdir(hooks)
  await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\necho fired >> "${marker.replaceAll('\\', '/')}"\n`, { mode: 0o755 })
  await git(directory, 'init', '-q', '-b', 'main', repository)
  await git(repository, 'config', 'user.name', 'Overcore Live Gate')
  await git(repository, 'config', 'user.email', 'live-gate@overcore.invalid')
  await git(repository, 'config', 'commit.gpgsign', 'false')
  await git(repository, 'config', 'core.hooksPath', hooks.replaceAll('\\', '/'))
  await writeFile(join(repository, 'src', 'sum.mjs'), 'export function sum(a, b) {\n  return a - b\n}\n', 'utf8')
  await writeFile(join(repository, 'test', 'sum.test.mjs'), [
    "import assert from 'node:assert/strict'",
    "import test from 'node:test'",
    "import { sum } from '../src/sum.mjs'",
    '',
    "test('sum soma dois inteiros', () => {",
    '  assert.equal(sum(2, 3), 5)',
    '  assert.equal(sum(-4, 4), 0)',
    '})',
    ''
  ].join('\n'), 'utf8')
  await git(repository, 'add', '-A')
  await git(repository, 'commit', '-q', '-m', 'base com defeito conhecido')
  const baseCommit = await git(repository, 'rev-parse', 'HEAD')
  await rm(marker, { force: true })
  return { repository, baseCommit, marker, repositoryUri: pathToFileURL(repository).href }
}

function repositoryRequest(repositoryUri: string, baseCommit: string, suffix: string, targetBranch: string): TaskRequest {
  const ref = `ref-repository-live-${suffix}`
  return {
    contractVersion: '1.0',
    requestId: `request-repository-live-${suffix}`,
    idempotencyKey: `repository-live-${suffix}`,
    createdAt: new Date().toISOString(),
    preflight: {
      draftId: `draft-repository-live-${suffix}`,
      draftRevision: 1,
      draftFingerprint: { algorithm: 'sha256-jcs-v1', value: sha256(`draft-${suffix}`) },
      readinessReportId: `readiness-repository-live-${suffix}`
    },
    client: { id: 'client-overcore-live-gate', kind: 'automation' },
    objective: 'Corrigir a função sum em src/sum.mjs, que subtrai em vez de somar.',
    priority: 'normal',
    context: {
      references: [{ refId: ref, uri: repositoryUri, kind: 'repository', sensitivity: 'internal' }],
      assumptions: []
    },
    constraints: [{ id: `constraint-scope-${suffix}`, kind: 'quality', description: 'Somente src/ pode mudar; o teste é a especificação.' }],
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
      id: `criterion-sum-${suffix}`,
      description: 'O branch novo corrige sum e test/sum.test.mjs passa.',
      verification: { method: 'test', expected: 'node --test test/sum.test.mjs termina com código 0.' }
    }],
    budget: { maxDurationMs: 300_000, maxAttempts: 1, maxParallelism: 1 },
    expectedOutput: { kind: 'repository-change', mediaType: 'text/x-diff', destinationRef: ref },
    execution: {
      kind: 'repository-change',
      resourceRef: ref,
      baseCommit,
      targetBranch,
      instructions: 'A função sum em src/sum.mjs subtrai em vez de somar. Corrija só esse arquivo para que test/sum.test.mjs passe. Não edite o teste.',
      pathScope: { include: ['src/**'], exclude: ['**/*.pem', '.env*'] },
      limits: { maxFilesChanged: 1, maxDiffBytes: 4_000 },
      verification: { argv: VERIFICATION, timeoutMs: 60_000, expectedExitCode: 0 }
    }
  }
}

test('gate real: Omni autoriza, Claude por login corrige o defeito na bancada e o branch passa no teste que falhava', {
  timeout: 600_000
}, async () => {
  if (process.env.OVERCORE_RUN_REPOSITORY_CHANGE_E2E !== 'I_UNDERSTAND_LOGIN_USAGE') {
    throw new Error('Gate não executado: defina OVERCORE_RUN_REPOSITORY_CHANGE_E2E=I_UNDERSTAND_LOGIN_USAGE.')
  }
  const databaseUrl = process.env.OVERCORE_TEST_DATABASE_URL
  const omniRepository = process.env.OVERCORE_OMNI_REPOSITORY_PATH
  if (!databaseUrl || !omniRepository) throw new Error('OVERCORE_TEST_DATABASE_URL e OVERCORE_OMNI_REPOSITORY_PATH são obrigatórias.')

  const directory = await mkdtemp(join(tmpdir(), 'overcore-repo-live-'))
  const token = randomBytes(32).toString('hex')
  const omni = await startOmni(omniRepository, token)
  const pool = createPostgresPool(databaseUrl)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
  const branch = `overcore/gate-real-${suffix}`
  let taskId: string | undefined
  try {
    const { repository, baseCommit, marker, repositoryUri } = await defectiveRepository(directory)
    assert.notEqual(await exitCode(repository, VERIFICATION), 0, 'controle: o teste falha no commit base')

    await migrate(pool, root)
    const validator = await ContractValidator.create(root)
    const store = new PostgresTaskStore(pool)
    const manager = new TaskManager(store, validator, new HttpAuthorityProvider(omni.endpoint, token))
    const worktreeRoot = join(directory, 'worktrees')
    const worker = new TaskWorker(
      `worker-repository-live-${process.pid}`, store, validator, new ReadOnlyContractInspectionExecutor(),
      undefined, undefined, undefined,
      new RepositoryChangeWorkbench(new ClaudeRepositoryEditor(), { worktreeRoot })
    )

    const scheduled = await manager.submit(repositoryRequest(repositoryUri, baseCommit, suffix, branch))
    taskId = scheduled.taskId
    assert.equal(
      scheduled.status,
      'running',
      `O Omni precisa autorizar o plano: ${JSON.stringify({ block: scheduled.result?.inputRequired, reconciliation: scheduled.reconciliation })}`
    )
    const authorization = await pool.query<{ provider_id: string, outcome: string }>(
      `SELECT decision_document -> 'issuer' ->> 'providerId' AS provider_id, decision_document ->> 'outcome' AS outcome
       FROM overcore_task_authorizations WHERE task_id = $1`,
      [taskId]
    )
    assert.deepEqual(authorization.rows, [{ provider_id: 'omni-authority-provider', outcome: 'permit-with-constraints' }])

    const completed = await worker.runOnce()
    assert.equal(completed?.status, 'succeeded', JSON.stringify(completed?.result))
    const result = completed!.result as JsonObject
    assert.equal((result.effects as JsonObject[])[0]?.status, 'confirmed')

    assert.equal(existsSync(marker), false, 'nenhum hook do repositório rodou durante a execução')

    const commit = await git(repository, 'rev-parse', `refs/heads/${branch}`)
    assert.equal(await git(repository, 'rev-parse', `${commit}^`), baseCommit, 'pai único igual ao commit base')
    assert.deepEqual(
      (await git(repository, 'diff-tree', '-r', '--name-only', '--no-commit-id', baseCommit, commit)).split('\n'),
      ['src/sum.mjs'],
      'o branch muda só o arquivo com defeito'
    )

    // Prova independente da bancada: o teste que falhava passa num checkout limpo do branch.
    const review = join(directory, 'review')
    await git(repository, 'worktree', 'add', '-q', '--detach', review, commit)
    try {
      assert.equal(await exitCode(review, VERIFICATION), 0, 'o teste passa no commit entregue')
    } finally {
      await git(repository, 'worktree', 'remove', '--force', review)
      await rm(marker, { force: true })
    }

    assert.equal(await git(repository, 'status', '--porcelain'), '', 'a working tree do dono continua limpa')
    assert.equal(await git(repository, 'rev-parse', 'HEAD'), baseCommit, 'o HEAD do dono não se move')
    assert.equal(await git(repository, 'symbolic-ref', '--short', 'HEAD'), 'main')
    assert.deepEqual(existsSync(worktreeRoot) ? await readdir(worktreeRoot) : [], [], 'nenhuma bancada sobra no disco')
  } finally {
    if (taskId) {
      for (const table of [
        'overcore_task_execution_receipts', 'overcore_task_outbox', 'overcore_task_authorizations',
        'overcore_task_plans', 'overcore_task_events', 'overcore_effect_journal', 'overcore_tasks'
      ]) {
        await pool.query(`DELETE FROM ${table} WHERE task_id=$1`, [taskId])
      }
    }
    await pool.end()
    await stop(omni.process)
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
