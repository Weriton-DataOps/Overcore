import { fingerprint, sha256 } from '../domain/fingerprint.js'
import type { PostgresTableProbeExecution, TaskRequest } from '../domain/types.js'

const TABLE_NAME = /^overcore_controlled_probe_[a-z0-9_]{8,64}$/

/** Lê a intenção congelada e recusa qualquer banco, tabela ou SQL fora da sonda local. */
export function postgresTableProbeFrom(request: TaskRequest): {
  execution: PostgresTableProbeExecution
  targetUri: string
} | null {
  if (!request.execution) return null
  const execution = request.execution
  if (execution.kind !== 'postgres-create-drop-table') return null
  if (execution.databaseName !== 'overcore_test' || !TABLE_NAME.test(execution.tableName)) {
    throw new Error('A sonda PostgreSQL aceita somente tabela temporária com prefixo controlado no overcore_test.')
  }
  const reference = request.context.references.find((item) => item.refId === execution.resourceRef)
  if (!reference || reference.kind !== 'service' || !reference.uri.startsWith('postgres:')) {
    throw new Error('A sonda PostgreSQL exige um serviço postgres:// declarado no contexto.')
  }
  const uri = new URL(reference.uri)
  if (uri.username || uri.password || uri.pathname !== '/overcore_test') {
    throw new Error('A referência PostgreSQL não pode transportar credencial e precisa apontar para overcore_test.')
  }
  const grant = request.authority.grants.find((item) => item.resourceRef === execution.resourceRef)
  if (!grant?.operations.includes('database.schema.modify') || !grant.operations.includes('database.schema.read')) {
    throw new Error('A autoridade precisa conceder database.schema.modify e database.schema.read ao serviço declarado.')
  }
  if (request.expectedOutput.destinationRef !== execution.resourceRef || request.expectedOutput.kind !== 'report') {
    throw new Error('A sonda PostgreSQL exige relatório com destinationRef do serviço declarado.')
  }
  return { execution, targetUri: reference.uri }
}

export function effectKeyForPostgresTableProbe(taskId: string, execution: PostgresTableProbeExecution): string {
  return `postgres-table-probe:${taskId}:${execution.resourceRef}:${sha256(execution.tableName).slice(-24)}`
}

export function probePayloadFromPlan(plan: Record<string, unknown>): { actionId: string, effectKey: string } {
  const steps = plan.steps
  if (!Array.isArray(steps)) throw new Error('Plano da sonda PostgreSQL não possui passos.')
  for (const rawStep of steps) {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) continue
    const actions = (rawStep as Record<string, unknown>).actions
    if (!Array.isArray(actions)) continue
    for (const rawAction of actions) {
      if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) continue
      const action = rawAction as Record<string, unknown>
      if (action.operation !== 'database.schema.modify') continue
      const policy = action.effectPolicy as Record<string, unknown> | undefined
      if (!policy || policy.mode !== 'journaled' || typeof action.actionId !== 'string' || typeof policy.effectKey !== 'string') {
        throw new Error('Plano da sonda PostgreSQL não possui efeito journaled válido.')
      }
      return { actionId: action.actionId, effectKey: policy.effectKey }
    }
  }
  throw new Error('Plano da sonda PostgreSQL não contém database.schema.modify.')
}

export function probeIntentFingerprint(input: {
  taskId: string
  effectKey: string
  resourceRef: string
  targetUri: string
  databaseName: string
  tableName: string
}) {
  return fingerprint({ ...input, operation: 'database.schema.modify', contract: 'postgres-table-probe-v1' })
}

export function probeAbsenceDigest(tableName: string): `sha256:${string}` {
  return sha256(`postgres-table-probe:absent:${tableName}`)
}

export function probeCompletionDigest(tableName: string): `sha256:${string}` {
  return sha256(`postgres-table-probe:completed:${tableName}`)
}
