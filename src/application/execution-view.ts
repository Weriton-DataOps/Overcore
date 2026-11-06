import type { JsonObject, StoredTask, TaskStatus } from '../domain/types.js'
import { executionStrategyFor, type ExecutionStrategy } from './execution-strategy.js'
import { repositoryUri } from './inspection-plan.js'
import { repositoryChangeFrom } from './repository-change.js'

/**
 * Projeção de leitura para a interface do Omni (docs/operacao/api-execucoes.md).
 *
 * Deriva tudo de StoredTask: não guarda estado próprio e não decide nada. Campo
 * novo entra sem quebrar quem lê; mudança de significado exige nova versão.
 */
export const EXECUTION_VIEW_VERSION = 1

const EXECUTOR_BY_STRATEGY: Record<ExecutionStrategy, string> = {
  inspection: 'overcore-contract-inspector-v1',
  'file-replacement': 'overcore-file-effect-harness-v1',
  'postgres-table-probe': 'overcore-postgres-table-probe-v1',
  'repository-change': 'overcore-repository-change-v1'
}

const STEP_BY_STATUS: Record<TaskStatus, string> = {
  accepted: 'admitida, aguardando planejamento',
  planning: 'planejando e pedindo autorização ao Omni',
  ready: 'autorizada, aguardando worker livre',
  running: 'executando',
  verifying: 'verificando a evidência',
  blocked: 'parada, aguardando resposta',
  cancelling: 'cancelando e reconciliando efeitos',
  succeeded: 'concluída',
  failed: 'falhou',
  cancelled: 'cancelada'
}

const ACTIVE: TaskStatus[] = ['running', 'verifying', 'cancelling']
const TERMINAL: TaskStatus[] = ['succeeded', 'failed', 'cancelled']

export type ExecutionView = JsonObject

function objectAt(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function strategyOf(task: StoredTask): ExecutionStrategy | null {
  try { return executionStrategyFor(task.request) } catch { return null }
}

function repositoryOf(task: StoredTask, strategy: ExecutionStrategy | null): JsonObject | null {
  try {
    if (strategy === 'repository-change') {
      const change = repositoryChangeFrom(task.request)
      return change
        ? { uri: change.repositoryUri, baseCommit: change.execution.baseCommit, targetBranch: change.execution.targetBranch }
        : null
    }
    if (strategy === 'inspection') return { uri: repositoryUri(task.request) }
  } catch { /* pedido inválido aparece como bloqueio, não como erro de leitura */ }
  return null
}

function currentStep(task: StoredTask, strategy: ExecutionStrategy | null): string {
  if (task.status === 'running' && strategy === 'repository-change') {
    return 'editando na worktree isolada e verificando antes de criar o branch'
  }
  return STEP_BY_STATUS[task.status]
}

function blockOf(task: StoredTask): JsonObject | null {
  if (task.status !== 'blocked') return null
  const input = objectAt(task.result?.inputRequired)
  if (!input) return null
  const replacement = input.mode === 'replacement-request-required'
  const id = encodeURIComponent(task.taskId)
  return {
    blockId: input.blockId ?? null,
    code: input.code ?? null,
    kind: input.kind ?? null,
    mode: input.mode ?? null,
    reason: input.reason ?? null,
    question: input.question ?? null,
    options: Array.isArray(input.options) ? input.options : [],
    impact: input.impact ?? null,
    answer: {
      resume: replacement ? null : `POST /v1/tasks/${id}/resume`,
      replace: replacement ? 'POST /v1/preflight com o TaskDraft corrigido' : null,
      cancel: `POST /v1/tasks/${id}/cancel`
    }
  }
}

function evidenceOf(task: StoredTask): JsonObject[] {
  const evidence = Array.isArray(task.result?.evidence) ? task.result.evidence as JsonObject[] : []
  return evidence.map((item) => ({
    evidenceId: item.evidenceId ?? null,
    kind: item.kind ?? null,
    summary: item.summary ?? null,
    capturedAt: item.capturedAt ?? null
  }))
}

/** Linha da listagem: o suficiente para um quadro, sem relatório nem ledger. */
export function executionSummary(task: StoredTask): ExecutionView {
  const strategy = strategyOf(task)
  const block = blockOf(task)
  const attempts = Array.isArray(task.state.ledger.attempts) ? task.state.ledger.attempts as JsonObject[] : []
  return {
    executionId: task.taskId,
    title: task.request.objective,
    kind: strategy,
    repository: repositoryOf(task, strategy),
    state: task.status,
    terminal: TERMINAL.includes(task.status),
    needsAnswer: block !== null,
    currentStep: currentStep(task, strategy),
    activeExecutors: ACTIVE.includes(task.status) && strategy ? [EXECUTOR_BY_STRATEGY[strategy]] : [],
    admittedAt: task.createdAt,
    startedAt: typeof attempts[0]?.startedAt === 'string' ? attempts[0].startedAt : null,
    lastActivityAt: task.updatedAt,
    attemptCount: attempts.length,
    block,
    resultSummary: typeof task.result?.summary === 'string' ? task.result.summary : null,
    evidence: evidenceOf(task)
  }
}

/** Detalhe: a linha da listagem mais relatório, artefatos, efeitos e trilha de transições. */
export function executionDetail(task: StoredTask): ExecutionView {
  const result = task.result
  const report = objectAt(result?.report)
  const transitions = Array.isArray(task.state.ledger.transitions) ? task.state.ledger.transitions as JsonObject[] : []
  return {
    ...executionSummary(task),
    stateRevision: task.stateRevision,
    request: {
      requestId: task.requestId,
      objective: task.request.objective,
      acceptanceCriteria: task.request.acceptanceCriteria.map((criterion) => ({ id: criterion.id, description: criterion.description })),
      ...(task.request.execution ? { execution: task.request.execution as unknown as JsonObject } : {})
    },
    result: result
      ? {
          resultId: result.resultId ?? null,
          status: result.status ?? null,
          summary: result.summary ?? null,
          report: report ? { mediaType: report.mediaType ?? null, content: report.content ?? null, digest: report.digest ?? null } : null,
          artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
          effects: Array.isArray(result.effects) ? result.effects : [],
          criteria: Array.isArray(result.criteria) ? result.criteria : []
        }
      : null,
    transitions: transitions.map((item) => ({
      to: item.to ?? null,
      from: item.from ?? null,
      at: item.at ?? null,
      triggerKind: item.triggerKind ?? null
    }))
  }
}
