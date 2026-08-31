import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface RuntimeDescriptor {
  schemaVersion: 1
  pid: number
  host: '127.0.0.1'
  port: number
  startedAt: string
}

export async function writeRuntimeDescriptor(directory: string, descriptor: RuntimeDescriptor): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'runtime.json')
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return path
}

export async function removeRuntimeDescriptor(path: string): Promise<void> {
  await rm(path, { force: true })
}
