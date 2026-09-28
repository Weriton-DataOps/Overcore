import type { TaskRequest } from '../domain/types.js'

export type ExecutionStrategy = 'inspection' | 'file-replacement' | 'postgres-table-probe'

/**
 * O contrato aceita um tipo de execução para o qual este processo ainda não
 * possui plano nem executor. A tarefa bloqueia em vez de cair em outra estratégia.
 */
export class UnsupportedExecutionKindError extends Error {
  constructor(readonly executionKind: string) {
    super(`O tipo de execução ${executionKind} ainda não possui plano nem executor neste Overcore.`)
    this.name = 'UnsupportedExecutionKindError'
  }
}

/**
 * Escolhe a estratégia de planejamento por correspondência exata e exaustiva.
 *
 * Um tipo novo no contrato não herda a estratégia de inspeção por omissão: ou
 * recebe um ramo explícito aqui, ou a tarefa é bloqueada antes de qualquer plano.
 */
export function executionStrategyFor(request: TaskRequest): ExecutionStrategy {
  const execution = request.execution
  if (!execution) return 'inspection'
  switch (execution.kind) {
    case 'replace-file-content':
      return 'file-replacement'
    case 'postgres-create-drop-table':
      return 'postgres-table-probe'
    case 'repository-change':
      throw new UnsupportedExecutionKindError(execution.kind)
    default: {
      const unknownExecution: never = execution
      throw new UnsupportedExecutionKindError(String((unknownExecution as { kind?: unknown }).kind))
    }
  }
}
