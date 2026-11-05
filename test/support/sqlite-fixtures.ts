import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

import { comBanco } from '../../src/infrastructure/database/sqlite/banco.js'
import { aplicarMigracoes } from '../../src/infrastructure/database/sqlite/migracoes.js'

export { avancar, emMinuto, evento, mensagem, minuto, tarefa } from './fixtures-de-tarefa.js'

/** Fixtures próprias do SQLite. Cada banco nasce numa pasta temporária própria. */

const pastas: string[] = []
after(async () => { await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true }))) })

export async function bancoMigrado(): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-sqlite-'))
  pastas.push(pasta)
  const arquivo = join(pasta, 'overcore.db')
  aplicarMigracoes(arquivo, join(process.cwd(), 'migrations-sqlite'))
  return arquivo
}

export function contar(arquivo: string, tabela: string): number {
  return Number(comBanco(arquivo, (db) => db.prepare(`SELECT count(*) AS n FROM ${tabela}`).get()?.n))
}
