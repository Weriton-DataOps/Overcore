import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TaskRequest } from '../domain/types.js'

/** Workspace addresses a directory literally; repository addresses its contracts folder. */
export function inspectionDirectory(uri: string, kind = 'repository'): string {
  if (!uri.startsWith('file:')) throw new Error('Inspeção exige referência local file://.')
  const path = fileURLToPath(uri)
  return kind === 'workspace' || basename(path).toLowerCase() === 'contratos' ? path : join(path, 'contratos')
}

export function inspectionTarget(request: TaskRequest): string {
  const reference = request.context.references.find(item => item.kind === 'repository' || item.kind === 'workspace')
  if (!reference) throw new Error('Inspeção exige referência repository ou workspace.')
  return inspectionDirectory(reference.uri, reference.kind)
}
