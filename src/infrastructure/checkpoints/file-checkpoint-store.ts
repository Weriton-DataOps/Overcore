import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { sha256 } from '../../domain/fingerprint.js'
import type { CheckpointArtifact, CheckpointStore } from '../../ports/effect-journal-store.js'

function safeName(checkpointRef: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(checkpointRef)) {
    throw new Error('Identificador de checkpoint inválido.')
  }
  return checkpointRef.replaceAll(':', '_')
}

export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly rootDirectory: string) {}

  async save(checkpointRef: string, content: Uint8Array): Promise<CheckpointArtifact> {
    await mkdir(this.rootDirectory, { recursive: true })
    const target = join(this.rootDirectory, `${safeName(checkpointRef)}.bin`)
    const digest = sha256(content)
    try {
      const existing = await readFile(target)
      if (sha256(existing) !== digest) throw new Error(`Checkpoint ${checkpointRef} já existe com outro conteúdo.`)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'ENOENT') throw error
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
      try {
        const handle = await open(temporary, 'wx')
        try {
          await handle.writeFile(content)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
    }
    return { checkpointRef, uri: pathToFileURL(target).href, digest }
  }

  async read(artifact: CheckpointArtifact): Promise<Uint8Array> {
    const path = fileURLToPath(artifact.uri)
    if (dirname(resolve(path)) !== resolve(this.rootDirectory)) {
      throw new Error('Checkpoint está fora do diretório operacional autorizado.')
    }
    const content = await readFile(path)
    if (sha256(content) !== artifact.digest) throw new Error(`Checkpoint ${artifact.checkpointRef} falhou na integridade.`)
    return content
  }
}
