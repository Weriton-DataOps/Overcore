import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DirectorySnapshot, InspectionEvidence } from '../domain/types.js'
import { sha256 } from '../domain/fingerprint.js'
import type { AgentRuntimeEvent } from '../ports/agent-runtime.js'

/** Nonrecursive: covers names and contents of regular files, never follows links. */
export async function snapshotDirectory(directory: string): Promise<DirectorySnapshot> {
  const snapshot: DirectorySnapshot = { directory: resolve(directory), capturedAt: new Date().toISOString(), complete: true, entries: [] }
  try {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const before = await lstat(path, { bigint: true })
      const kind = before.isSymbolicLink() ? 'link' : before.isFile() ? 'file' : before.isDirectory() ? 'directory' : 'other'
      const digest = kind === 'file' ? sha256(await readFile(path)) : ''
      const after = await lstat(path, { bigint: true })
      if (['link', 'other'].includes(kind) || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) snapshot.complete = false
      snapshot.entries.push({ name, kind, digest, modified: after.mtimeNs.toString(), changed: after.ctimeNs.toString() })
    }
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(snapshot.entries.map(entry => entry.name))) snapshot.complete = false
  } catch { snapshot.complete = false }
  return snapshot
}

export function inspectionToolAudit(events: AgentRuntimeEvent[]): NonNullable<InspectionEvidence['nonMutation']>['tools'] {
  const allowed = events.filter(event => event.type === 'tool-allowed').map(event => String(event.data.toolName))
  const denied = events.filter(event => event.type === 'tool-denied').map(event => String(event.data.toolName))
  return {
    complete: events.some(event => event.type === 'runtime-started') && events.some(event => event.type === 'runtime-result'),
    allowed, denied
  }
}

export function verifyNonMutation(proof: InspectionEvidence['nonMutation']): void {
  if (!proof || proof.scope !== 'directory-top-level' || !proof.before.complete || !proof.after.complete ||
      proof.before.directory !== proof.after.directory || !proof.tools.complete) throw new Error('Ausência de mutação sem snapshots completos e registro de execução.')
  if (proof.tools.allowed.some(tool => !['Read', 'Glob', 'Grep'].includes(tool))) throw new Error('Execução autorizou ferramenta fora do conjunto somente leitura.')
  if (JSON.stringify(proof.before.entries) !== JSON.stringify(proof.after.entries)) throw new Error('Diferença observada entre snapshots: criação, remoção, conteúdo ou metadados alterados.')
}
