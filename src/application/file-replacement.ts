import { fileURLToPath } from 'node:url'

import { sha256 } from '../domain/fingerprint.js'
import type { FileReplacementExecution, JsonObject, TaskRequest } from '../domain/types.js'

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} invalido.`)
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} invalido.`)
  return value
}

/**
 * Lê e valida a intenção material congelada no TaskRequest.
 *
 * A referência precisa apontar para um único arquivo declarado no contexto e
 * ter grant explícito de filesystem.modify. Não há inferência do objetivo.
 */
export function fileReplacementFrom(request: TaskRequest): {
  execution: FileReplacementExecution
  targetUri: string
} | null {
  if (!request.execution) return null
  const execution = request.execution
  if (execution.kind !== 'replace-file-content') return null
  if (!/^sha256:[a-f0-9]{64}$/.test(execution.expectedBeforeDigest)) {
    throw new Error('A substituição exige expectedBeforeDigest SHA-256 válido.')
  }
  const reference = request.context.references.find((item) => item.refId === execution.resourceRef)
  if (!reference || reference.kind !== 'file' || !reference.uri.startsWith('file:')) {
    throw new Error('A substituição exige uma referência file:// declarada no contexto.')
  }
  // Resolve agora para recusar URI de arquivo malformada antes de pedir autoridade.
  fileURLToPath(reference.uri)
  const grant = request.authority.grants.find((item) => item.resourceRef === execution.resourceRef)
  if (!grant?.operations.includes('filesystem.modify')) {
    throw new Error('A autoridade da tarefa não concede filesystem.modify ao arquivo declarado.')
  }
  if (request.expectedOutput.destinationRef !== execution.resourceRef) {
    throw new Error('A saída material precisa declarar o mesmo destinationRef do arquivo alterado.')
  }
  if (!['file', 'repository-change'].includes(request.expectedOutput.kind)) {
    throw new Error('A substituição de arquivo exige saída file ou repository-change.')
  }
  return { execution, targetUri: reference.uri }
}

export function effectKeyForFileReplacement(taskId: string, execution: FileReplacementExecution): string {
  return `file-replacement:${taskId}:${execution.resourceRef}:${sha256(execution.desiredContent).slice(-24)}`
}

export function replacementPayloadFromPlan(plan: JsonObject): {
  actionId: string
  effectKey: string
} {
  const steps = plan.steps
  if (!Array.isArray(steps)) throw new Error('Plano de substituição não possui passos.')
  for (const rawStep of steps) {
    const step = object(rawStep, 'passo do plano')
    const actions = step.actions
    if (!Array.isArray(actions)) continue
    for (const rawAction of actions) {
      const action = object(rawAction, 'ação do plano')
      if (action.operation !== 'filesystem.modify') continue
      const policy = object(action.effectPolicy, 'policy de efeito')
      if (policy.mode !== 'journaled') throw new Error('A alteração material não possui journal.')
      return {
        actionId: text(action.actionId, 'actionId'),
        effectKey: text(policy.effectKey, 'effectKey')
      }
    }
  }
  throw new Error('Plano de substituição não contém filesystem.modify.')
}
