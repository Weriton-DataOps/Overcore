import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fingerprint, sha256, stableId } from '../domain/fingerprint.js'
import type { JsonObject, RepositoryChangeExecution } from '../domain/types.js'
import { guardedEffect, type CancellationProjection, type ExecutionControl } from '../ports/execution-control.js'
import type { RepositoryEditor } from '../ports/repository-editor.js'
import { ExecutionFailure, type RepositoryChangeExecutor } from '../ports/task-store.js'
import { RepositoryPathGuard } from './repository-path-guard.js'
import { effectTrailer, inspectTargetBranch } from './repository-change.js'
import { git, runGit, runProcess, sanitizedEnvironment } from './repository-git.js'

const EXECUTOR_ID = 'overcore-repository-change-v1'
const NO_REF = '0'.repeat(40)
const OUTPUT_TAIL = 4_000

type ExecuteInput = Parameters<RepositoryChangeExecutor['execute']>[0]

interface ChangedFile {
  path: string
  status: string
  added: number
  deleted: number
}

interface Measurement {
  files: ChangedFile[]
  diffBytes: number
  patchDigest: `sha256:${string}`
}

interface Verification {
  argv: string[]
  exitCode: number
  durationMs: number
  outputDigest: `sha256:${string}`
  outputTail: string
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text
}

function commitTitle(objective: string): string {
  const line = objective.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return `overcore: ${line.length > 72 ? `${line.slice(0, 69)}...` : line || 'mudança de repositório'}`
}

/**
 * Bancada da ADR-022: worktree destacado fora do repositório do proprietário,
 * editor confinado ao escopo, medição contra o commit base e um único efeito
 * (criar o branch local) protegido pela cerca de execução.
 *
 * O tree publicado é o tree medido antes da verificação: o que a verificação
 * escrever no disco não entra no commit.
 */
export class RepositoryChangeWorkbench implements RepositoryChangeExecutor {
  private readonly now: () => Date

  constructor(
    private readonly editor: RepositoryEditor,
    private readonly options: { worktreeRoot: string; now?: () => Date }
  ) {
    this.now = options.now ?? (() => new Date())
  }

  workbenchPath(taskId: string, effectKey: string): string {
    return join(this.options.worktreeRoot, stableId('bancada', `${taskId}:${effectKey}`))
  }

  async execute(input: ExecuteInput, control?: ExecutionControl): Promise<JsonObject> {
    const { execution, effectKey, taskId } = input
    const repositoryPath = fileURLToPath(input.repositoryUri)
    const signal = control?.signal ?? new AbortController().signal

    const before = await inspectTargetBranch(repositoryPath, execution.targetBranch, execution.baseCommit, effectKey)
    if (before.status === 'foreign') {
      throw new ExecutionFailure('repository-branch-exists', 'resource', false,
        `O branch ${execution.targetBranch} apareceu durante a execução e não pertence a esta tarefa.`)
    }
    if (before.status === 'confirmed') {
      // Redelivery depois do efeito: o branch já é desta tarefa; só relemos.
      const measurement = await this.measure(repositoryPath, execution, before.tree, null)
      return this.project(input, { measurement, commit: before.commit, tree: before.tree, wrote: false,
        report: 'O branch desta tarefa já existia com a mesma chave de efeito; nada foi editado de novo.' })
    }

    const workbench = this.workbenchPath(taskId, effectKey)
    await mkdir(this.options.worktreeRoot, { recursive: true })
    await this.discardWorkbench(repositoryPath, workbench)
    try {
      await git(repositoryPath, ['worktree', 'add', '--detach', workbench, execution.baseCommit], { signal })
      const guard = await RepositoryPathGuard.create(workbench, execution.pathScope)
      const edited = await this.edit(input, workbench, guard, signal)
      await control?.assertActive()

      await git(workbench, ['add', '-A'], { signal })
      const tree = (await git(workbench, ['write-tree'], { signal })).trim()
      const measurement = await this.measure(workbench, execution, tree, guard)
      const verification = execution.verification
        ? await this.verify(workbench, execution.verification, signal)
        : undefined
      await control?.assertActive()

      if (Date.parse(input.authorization.expiresAt) <= this.now().getTime()) {
        throw new ExecutionFailure('repository-authorization-expired', 'policy', false,
          'A autorização venceu antes da criação do branch; nenhum ref foi escrito.')
      }
      const message = `${commitTitle(input.objective)}\n\nOvercore-Task: ${taskId}\n${effectTrailer(effectKey)}\n`
      const commit = (await git(repositoryPath, ['commit-tree', tree, '-p', execution.baseCommit, '-m', message], { signal })).trim()
      const published = await guardedEffect(control, () => this.createBranch(repositoryPath, execution, effectKey, commit))
      return this.project(input, {
        measurement,
        commit: published.commit,
        tree,
        wrote: published.wrote,
        report: edited.report,
        ...(verification ? { verification } : {}),
        ...(edited.tokens !== undefined ? { tokens: edited.tokens } : {}),
        ...(edited.costUsd !== undefined ? { costUsd: edited.costUsd } : {})
      })
    } finally {
      await this.discardWorkbench(repositoryPath, workbench)
    }
  }

  async reconcileCancellation(input: {
    taskId: string
    effectKey: string
    targetUri: string
    targetBranch: string
    baseCommit: string
    resourceRef: string
  }): Promise<CancellationProjection> {
    const repositoryPath = fileURLToPath(input.targetUri)
    await this.discardWorkbench(repositoryPath, this.workbenchPath(input.taskId, input.effectKey))
    const state = await inspectTargetBranch(repositoryPath, input.targetBranch, input.baseCommit, input.effectKey)
    const capturedAt = this.now().toISOString()
    const evidenceId = stableId('evidence-repository-cancel-readback', `${input.effectKey}:${state.status}`)
    const summary = state.status === 'confirmed'
      ? `O branch ${input.targetBranch} já tinha sido criado por esta tarefa (commit ${state.commit}) e fica para revisão.`
      : state.status === 'foreign'
        ? `O branch ${input.targetBranch} existe, mas não foi criado por esta tarefa; nada foi alterado.`
        : `O branch ${input.targetBranch} não existe; a tarefa terminou sem efeito no repositório.`
    return {
      evidence: [{
        evidenceId,
        kind: 'state-readback',
        capturedAt,
        summary,
        digest: sha256(JSON.stringify({ targetBranch: input.targetBranch, ...state })),
        artifactRefs: [],
        origin: { kind: 'executor', id: EXECUTOR_ID }
      }],
      artifacts: [],
      effects: [{
        effectId: stableId('effect-repository-branch', input.effectKey),
        effectKey: input.effectKey,
        intentFingerprint: this.intent(input.targetUri, input.targetBranch, input.baseCommit, input.effectKey),
        resourceRef: input.resourceRef,
        operation: 'repository.branch.create',
        status: state.status === 'confirmed' ? 'confirmed' : 'not-applied',
        evidenceRefs: [evidenceId]
      }]
    }
  }

  private async edit(input: ExecuteInput, workbench: string, guard: RepositoryPathGuard, signal: AbortSignal) {
    const timeout = AbortSignal.timeout(input.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    try {
      return await this.editor.edit({
        taskId: input.taskId,
        worktreePath: workbench,
        objective: input.objective,
        instructions: input.execution.instructions,
        pathScope: input.execution.pathScope,
        checkPath: (candidate) => guard.check(candidate),
        timeoutMs: input.timeoutMs,
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {})
      }, combined)
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      if (timeout.aborted) {
        throw new ExecutionFailure('repository-edit-timeout', 'resource', false,
          `O editor não terminou em ${input.timeoutMs} ms; a bancada foi descartada.`)
      }
      if (error instanceof ExecutionFailure) throw error
      throw new ExecutionFailure('repository-edit-failed', 'external', false,
        `O editor falhou: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Mede o tree contra o commit base. Com guarda, aplica escopo e limites;
   * sem guarda (releitura de um branch já confirmado) só descreve.
   */
  private async measure(
    cwd: string,
    execution: RepositoryChangeExecution,
    tree: string,
    guard: RepositoryPathGuard | null
  ): Promise<Measurement> {
    const base = execution.baseCommit
    const raw = (await git(cwd, ['diff-tree', '-r', '-z', '--no-renames', base, tree])).split('\0')
    const statuses = new Map<string, string>()
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const header = raw[index] ?? ''
      const path = raw[index + 1] ?? ''
      if (!header.startsWith(':')) break
      const [sourceMode, targetMode, , , status] = header.slice(1).split(' ')
      if (guard && [sourceMode, targetMode].some((mode) => mode === '120000' || mode === '160000')) {
        throw new ExecutionFailure('repository-link-change', 'policy', false,
          `${path} é link simbólico ou submódulo; a v1 só publica arquivos comuns.`)
      }
      statuses.set(path, status ?? 'M')
    }
    const numstat = (await git(cwd, ['diff-tree', '-r', '-z', '--numstat', '--no-renames', base, tree]))
      .split('\0').filter(Boolean)
    const files: ChangedFile[] = []
    for (const line of numstat) {
      const [added, deleted, ...rest] = line.split('\t')
      const path = rest.join('\t')
      if (guard && (added === '-' || deleted === '-')) {
        throw new ExecutionFailure('repository-binary-change', 'policy', false,
          `${path} mudou como binário; a v1 só publica texto.`)
      }
      files.push({ path, status: statuses.get(path) ?? 'M', added: Number(added) || 0, deleted: Number(deleted) || 0 })
    }
    const patch = await git(cwd, ['diff-tree', '-r', '-p', '--no-renames', '--no-ext-diff', '--no-textconv', base, tree])
    const diffBytes = Buffer.byteLength(patch, 'utf8')
    if (guard) {
      if (files.length === 0) {
        throw new ExecutionFailure('repository-change-empty', 'verification', false,
          'O editor terminou sem nenhuma mudança contra o commit base.')
      }
      for (const file of files) {
        const decision = await guard.check(file.path)
        if (!decision.allowed) {
          throw new ExecutionFailure('repository-path-out-of-scope', 'policy', false,
            `${file.path} está fora do escopo declarado (${decision.reason}).`)
        }
      }
      if (files.length > execution.limits.maxFilesChanged || diffBytes > execution.limits.maxDiffBytes) {
        throw new ExecutionFailure('repository-change-too-large', 'policy', false,
          `A mudança tem ${files.length} arquivo(s) e ${diffBytes} bytes de diff; o limite é ` +
          `${execution.limits.maxFilesChanged} arquivo(s) e ${execution.limits.maxDiffBytes} bytes.`)
      }
    }
    return { files, diffBytes, patchDigest: sha256(patch) }
  }

  private async verify(
    workbench: string,
    verification: NonNullable<RepositoryChangeExecution['verification']>,
    signal: AbortSignal
  ): Promise<Verification> {
    const [file, ...args] = verification.argv
    if (!file) throw new ExecutionFailure('repository-verification-invalid', 'policy', false, 'A verificação não declara executável.')
    const startedAt = Date.now()
    const result = await runProcess(file, args, {
      cwd: workbench,
      env: sanitizedEnvironment(),
      timeoutMs: verification.timeoutMs,
      signal
    }).catch((error: unknown) => {
      if (signal.aborted) throw signal.reason ?? error
      throw new ExecutionFailure('repository-verification-unavailable', 'resource', false,
        `A verificação ${verification.argv.join(' ')} não pôde ser iniciada: ${error instanceof Error ? error.message : String(error)}`)
    })
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`
    if (result.timedOut) {
      throw new ExecutionFailure('repository-verification-timeout', 'resource', false,
        `A verificação passou de ${verification.timeoutMs} ms. Saída final:\n${tail(output).slice(-1500)}`)
    }
    if (result.exitCode !== verification.expectedExitCode) {
      throw new ExecutionFailure('repository-verification-failed', 'verification', false,
        `A verificação terminou com código ${result.exitCode}; o esperado era ${verification.expectedExitCode}. ` +
        `Saída final:\n${tail(output).slice(-1500)}`)
    }
    return {
      argv: verification.argv,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      outputDigest: sha256(output),
      outputTail: tail(output)
    }
  }

  /** Cria o ref só se ele não existir; perder a corrida para um ref alheio é falha, nunca sobrescrita. */
  private async createBranch(
    repositoryPath: string,
    execution: RepositoryChangeExecution,
    effectKey: string,
    commit: string
  ): Promise<{ commit: string; wrote: boolean }> {
    const ref = `refs/heads/${execution.targetBranch}`
    const update = await runGit(repositoryPath, ['update-ref', '-m', `overcore: ${effectKey}`, ref, commit, NO_REF])
    if (update.exitCode === 0) return { commit, wrote: true }
    const state = await inspectTargetBranch(repositoryPath, execution.targetBranch, execution.baseCommit, effectKey)
    if (state.status === 'confirmed') return { commit: state.commit, wrote: false }
    throw new ExecutionFailure('repository-branch-exists', 'resource', false,
      `O branch ${execution.targetBranch} foi criado por outro processo antes desta tarefa: ${update.stderr.trim().slice(0, 300)}`)
  }

  private async readback(repositoryPath: string, branch: string, commit: string, tree: string): Promise<void> {
    const ref = (await git(repositoryPath, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim()
    const readTree = (await git(repositoryPath, ['rev-parse', '--verify', `${commit}^{tree}`])).trim()
    if (ref !== commit || readTree !== tree) {
      throw new ExecutionFailure('repository-readback-mismatch', 'verification', false,
        `O branch ${branch} relido aponta para ${ref} (tree ${readTree}), não para ${commit} (tree ${tree}).`,
        undefined, true)
    }
  }

  private intent(repositoryUri: string, targetBranch: string, baseCommit: string, effectKey: string) {
    return fingerprint({ operation: 'repository.branch.create', repositoryUri, targetBranch, baseCommit, effectKey })
  }

  private async project(input: ExecuteInput, outcome: {
    measurement: Measurement
    commit: string
    tree: string
    wrote: boolean
    report: string
    verification?: Verification
    tokens?: number
    costUsd?: number
  }): Promise<JsonObject> {
    const { execution, effectKey, repositoryUri } = input
    const repositoryPath = fileURLToPath(repositoryUri)
    await this.readback(repositoryPath, execution.targetBranch, outcome.commit, outcome.tree)
    const capturedAt = this.now().toISOString()
    const seed = `${effectKey}:${outcome.commit}`
    const patchArtifact = stableId('artifact-repository-patch', seed)
    const checkpointArtifact = stableId('artifact-repository-base', seed)
    const diffEvidence = stableId('evidence-repository-diff', seed)
    const testEvidence = stableId('evidence-repository-verification', seed)
    const readbackEvidence = stableId('evidence-repository-readback', seed)
    const { measurement, verification } = outcome
    const origin = { kind: 'executor', id: EXECUTOR_ID }
    const evidence: JsonObject[] = [{
      evidenceId: diffEvidence,
      kind: 'inspection',
      capturedAt,
      summary: `${measurement.files.length} arquivo(s) e ${measurement.diffBytes} bytes de diff contra ` +
        `${execution.baseCommit.slice(0, 12)}, dentro do escopo e dos limites declarados.`,
      digest: measurement.patchDigest,
      artifactRefs: [patchArtifact],
      origin
    }]
    if (verification) {
      evidence.push({
        evidenceId: testEvidence,
        kind: 'test-result',
        capturedAt,
        summary: `A verificação ${verification.argv.join(' ')} terminou com código ${verification.exitCode} ` +
          `em ${verification.durationMs} ms, sem shell e com ambiente filtrado.`,
        digest: verification.outputDigest,
        artifactRefs: [],
        origin
      })
    }
    evidence.push({
      evidenceId: readbackEvidence,
      kind: 'state-readback',
      capturedAt,
      summary: `refs/heads/${execution.targetBranch} relido em ${outcome.commit} (tree ${outcome.tree}, pai ${execution.baseCommit}).`,
      digest: sha256(`${execution.targetBranch}:${outcome.commit}:${outcome.tree}:${execution.baseCommit}`),
      artifactRefs: [checkpointArtifact],
      origin
    })
    const artifacts: JsonObject[] = [
      {
        artifactId: patchArtifact,
        kind: 'patch',
        uri: `${repositoryUri}#commit=${outcome.commit}`,
        digest: measurement.patchDigest,
        mediaType: 'text/x-diff',
        sensitivity: 'internal',
        createdAt: capturedAt
      },
      {
        artifactId: checkpointArtifact,
        kind: 'checkpoint',
        uri: `${repositoryUri}#commit=${execution.baseCommit}`,
        digest: sha256(execution.baseCommit),
        mediaType: 'application/x-git-commit',
        sensitivity: 'internal',
        createdAt: capturedAt
      }
    ]
    const effects: JsonObject[] = [{
      effectId: stableId('effect-repository-branch', effectKey),
      effectKey,
      intentFingerprint: this.intent(repositoryUri, execution.targetBranch, execution.baseCommit, effectKey),
      resourceRef: execution.resourceRef,
      operation: 'repository.branch.create',
      status: 'confirmed',
      evidenceRefs: [readbackEvidence]
    }]
    return {
      effectKey,
      wrote: outcome.wrote,
      branch: execution.targetBranch,
      commit: outcome.commit,
      tree: outcome.tree,
      baseCommit: execution.baseCommit,
      changedFiles: measurement.files as unknown as JsonObject[],
      diffBytes: measurement.diffBytes,
      ...(verification ? { verification: verification as unknown as JsonObject } : {}),
      editorReport: outcome.report,
      ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      taskResultProjection: { evidence, artifacts, effects, checkpointArtifactRef: checkpointArtifact }
    }
  }

  private async discardWorkbench(repositoryPath: string, workbench: string): Promise<void> {
    const removed = await runGit(repositoryPath, ['worktree', 'remove', '--force', workbench]).catch(() => null)
    await rm(workbench, { recursive: true, force: true, maxRetries: 3 })
    // Só poda quando o remove não achou o worktree: podar sempre disputaria
    // com o `worktree add` de outra tarefa no mesmo repositório.
    if (removed?.exitCode !== 0) await runGit(repositoryPath, ['worktree', 'prune']).catch(() => null)
  }
}
