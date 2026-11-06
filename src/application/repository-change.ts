import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { sha256 } from '../domain/fingerprint.js'
import type { JsonObject, RepositoryChangeExecution, TaskRequest } from '../domain/types.js'
import { runGit } from './repository-git.js'

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`)
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} inválido.`)
  return value
}

/** O pedido declara uma mudança de repositório que a v1 não pode aceitar como está. */
export class RepositoryChangeRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryChangeRequestError'
  }
}

/** O repositório real não está no estado que o pedido pressupõe. */
export class RepositoryPreconditionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RepositoryPreconditionError'
  }
}

const REQUIRED_OPERATIONS = ['repository.read', 'repository.worktree.modify', 'repository.branch.create']

/**
 * Lê a mudança de repositório congelada no TaskRequest.
 *
 * Exige referência `repository` em `file://` local, grant explícito de cada
 * operação que o plano vai pedir e saída `repository-change` no mesmo recurso.
 */
export function repositoryChangeFrom(request: TaskRequest): {
  execution: RepositoryChangeExecution
  repositoryUri: string
  repositoryPath: string
} | null {
  const execution = request.execution
  if (!execution || execution.kind !== 'repository-change') return null
  const reference = request.context.references.find((item) => item.refId === execution.resourceRef)
  if (!reference || reference.kind !== 'repository' || !reference.uri.startsWith('file:')) {
    throw new RepositoryChangeRequestError('A mudança de repositório exige uma referência repository file:// declarada no contexto.')
  }
  let repositoryPath: string
  try {
    repositoryPath = fileURLToPath(reference.uri)
  } catch {
    throw new RepositoryChangeRequestError('A URI do repositório não é um caminho local válido.')
  }
  if (repositoryPath.startsWith('\\\\') || repositoryPath.startsWith('//')) {
    throw new RepositoryChangeRequestError('Repositório em compartilhamento de rede está fora da v1 da ADR-022.')
  }
  const grant = request.authority.grants.find((item) => item.resourceRef === execution.resourceRef)
  const required = [...REQUIRED_OPERATIONS, ...(execution.verification ? ['process.execute'] : [])]
  const missing = required.filter((operation) => !grant?.operations.includes(operation))
  if (missing.length > 0) {
    throw new RepositoryChangeRequestError(`A autoridade da tarefa não concede ${missing.join(', ')} ao repositório declarado.`)
  }
  if (request.expectedOutput.destinationRef !== execution.resourceRef) {
    throw new RepositoryChangeRequestError('A saída precisa declarar o repositório alterado como destinationRef.')
  }
  if (request.expectedOutput.kind !== 'repository-change') {
    throw new RepositoryChangeRequestError('A mudança de repositório exige saída repository-change.')
  }
  return { execution, repositoryUri: reference.uri, repositoryPath }
}

export function effectKeyForRepositoryChange(taskId: string, execution: RepositoryChangeExecution): string {
  return `repository-change:${taskId}:${sha256(`${execution.baseCommit}:${execution.targetBranch}`).slice(-24)}`
}

/** Trailer que liga o commit publicado ao efeito journaled que o criou. */
export function effectTrailer(effectKey: string): string {
  return `Overcore-Effect-Key: ${effectKey}`
}

export function repositoryChangePayloadFromPlan(plan: JsonObject): {
  actionId: string
  effectKey: string
} {
  const steps = plan.steps
  if (!Array.isArray(steps)) throw new Error('Plano de mudança de repositório não possui passos.')
  for (const rawStep of steps) {
    const actions = object(rawStep, 'passo do plano').actions
    if (!Array.isArray(actions)) continue
    for (const rawAction of actions) {
      const action = object(rawAction, 'ação do plano')
      if (action.operation !== 'repository.branch.create') continue
      const policy = object(action.effectPolicy, 'policy de efeito')
      if (policy.mode !== 'journaled') throw new Error('A criação do branch não possui journal.')
      return { actionId: text(action.actionId, 'actionId'), effectKey: text(policy.effectKey, 'effectKey') }
    }
  }
  throw new Error('Plano de mudança de repositório não contém repository.branch.create.')
}

export type TargetBranchState =
  | { status: 'absent' }
  | { status: 'confirmed'; commit: string; tree: string }
  | { status: 'foreign'; commit: string }

/**
 * Lê o ref de destino e decide se ele é o efeito desta tarefa.
 *
 * Sem journal próprio, a prova é o conteúdo endereçado: um único pai igual ao
 * commit base e o trailer com a mesma effectKey. Qualquer outra coisa é alheia.
 */
export async function inspectTargetBranch(
  repositoryPath: string,
  targetBranch: string,
  baseCommit: string,
  effectKey: string
): Promise<TargetBranchState> {
  const found = await runGit(repositoryPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${targetBranch}^{commit}`])
  if (found.exitCode !== 0) return { status: 'absent' }
  const commit = found.stdout.trim()
  const raw = await runGit(repositoryPath, ['cat-file', 'commit', commit])
  if (raw.exitCode !== 0) return { status: 'foreign', commit }
  const separator = raw.stdout.indexOf('\n\n')
  const header = separator >= 0 ? raw.stdout.slice(0, separator) : raw.stdout
  const message = separator >= 0 ? raw.stdout.slice(separator + 2) : ''
  const parents = header.split('\n').filter((line) => line.startsWith('parent ')).map((line) => line.slice(7).trim())
  const tree = header.split('\n').find((line) => line.startsWith('tree '))?.slice(5).trim() ?? ''
  const ours = parents.length === 1 && parents[0] === baseCommit &&
    message.split('\n').some((line) => line.trim() === effectTrailer(effectKey))
  return ours ? { status: 'confirmed', commit, tree } : { status: 'foreign', commit }
}

/**
 * Confere, antes de planejar, o que só o disco sabe: o caminho é um
 * repositório Git, o commit base existe e o branch de destino está livre.
 */
export async function assertRepositoryPreconditions(
  repositoryPath: string,
  execution: RepositoryChangeExecution,
  effectKey: string
): Promise<void> {
  const launcher = execution.verification?.argv[0]
  if (launcher && /\.(cmd|bat)$/i.test(launcher)) {
    throw new RepositoryPreconditionError(
      'repository-verification-launcher-unsupported',
      `A verificação usa ${launcher}, que exige shell; a v1 executa argv sem shell. Use o executável direto, como node <script>.`
    )
  }
  const info = await stat(repositoryPath).catch(() => null)
  if (!info?.isDirectory()) {
    throw new RepositoryPreconditionError('repository-not-found', `O repositório declarado não existe em ${repositoryPath}.`)
  }
  let gitDir
  try {
    gitDir = await runGit(repositoryPath, ['rev-parse', '--git-dir'])
  } catch (error) {
    throw new RepositoryPreconditionError('git-unavailable', `O Git não pôde ser executado: ${(error as Error).message}`)
  }
  if (gitDir.exitCode !== 0) {
    throw new RepositoryPreconditionError('repository-not-git', `${repositoryPath} não é um repositório Git.`)
  }
  const base = await runGit(repositoryPath, ['cat-file', '-e', `${execution.baseCommit}^{commit}`])
  if (base.exitCode !== 0) {
    throw new RepositoryPreconditionError('repository-base-commit-missing', `O commit base ${execution.baseCommit} não existe no repositório.`)
  }
  const branch = await inspectTargetBranch(repositoryPath, execution.targetBranch, execution.baseCommit, effectKey)
  if (branch.status === 'foreign') {
    throw new RepositoryPreconditionError(
      'repository-branch-exists',
      `O branch ${execution.targetBranch} já existe (commit ${branch.commit}) e não foi criado por esta tarefa.`
    )
  }
}
