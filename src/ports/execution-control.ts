import type { JsonObject } from '../domain/types.js'

/** The fence is checked under the same persistent lock used by cancellation. */
export interface ExecutionControl {
  signal: AbortSignal
  assertActive(): Promise<void>
  runEffect<T>(operation: () => Promise<T>): Promise<T>
}

export interface CancellationProjection {
  evidence: JsonObject[]
  artifacts: JsonObject[]
  effects: JsonObject[]
}

export class ExecutionInterruptedError extends Error {
  constructor() {
    super('Execução interrompida: cancelamento, epoch ou posse da fila mudou.')
    this.name = 'ExecutionInterruptedError'
  }
}

export function guardedEffect<T>(control: ExecutionControl | undefined, operation: () => Promise<T>): Promise<T> {
  return control ? control.runEffect(operation) : operation()
}
