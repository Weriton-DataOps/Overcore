import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { comBanco, transacao } from './banco.js'

/**
 * Migrações do motor SQLite (ADR-023 D7). Ficam fora de `migrations/`, que o
 * PostgreSQL lê por inteiro. O hash é calculado sobre o texto em LF: com
 * autocrlf, o mesmo commit vira CRLF numa máquina e LF em outra.
 */

const PADRAO = /^(\d{4})_([a-z0-9_]+)\.sql$/

export interface Migracao { versao: number; nome: string; sql: string; sha256: string }

export function hashMigracao(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

/** O nome que a casa mostra: `0001_overcore`. */
export const nomeDaMigracao = (m: { versao: number; nome: string }): string => `${String(m.versao).padStart(4, '0')}_${m.nome}`

export interface SituacaoDasMigracoes {
  aplicadas: string[]
  pendentes: string[]
  alteradas: string[]
  desconhecidas: string[]
}

/** Compara o banco com a pasta sem escrever nada. Banco sem `_migracoes` conta como tudo pendente. */
export function situacaoDasMigracoes(arquivo: string, diretorio: string): SituacaoDasMigracoes {
  const migracoes = lerMigracoes(diretorio)
  const db = new DatabaseSync(arquivo, { readOnly: true })
  try {
    const temTabela = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migracoes'").get()
    const linhas = temTabela
      ? db.prepare('SELECT versao, nome, sha256 FROM _migracoes ORDER BY versao').all() as unknown as { versao: number; nome: string; sha256: string }[]
      : []
    const noBanco = new Map(linhas.map((l) => [Number(l.versao), l]))
    return {
      aplicadas: linhas.map(nomeDaMigracao),
      pendentes: migracoes.filter((m) => !noBanco.has(m.versao)).map(nomeDaMigracao),
      alteradas: migracoes.filter((m) => noBanco.has(m.versao) && noBanco.get(m.versao)?.sha256 !== m.sha256).map(nomeDaMigracao),
      desconhecidas: linhas.filter((l) => !migracoes.some((m) => m.versao === Number(l.versao))).map(nomeDaMigracao)
    }
  } finally {
    db.close()
  }
}

export function lerMigracoes(diretorio: string): Migracao[] {
  const migracoes: Migracao[] = []
  for (const arquivo of readdirSync(diretorio)) {
    if (!arquivo.endsWith('.sql')) continue
    const partes = PADRAO.exec(arquivo)
    if (!partes) throw new Error(`Nome de migração fora do padrão NNNN_nome.sql: ${arquivo}`)
    const versao = Number(partes[1])
    if (migracoes.some((migracao) => migracao.versao === versao)) throw new Error(`Versão de migração repetida: ${versao}`)
    const sql = readFileSync(join(diretorio, arquivo), 'utf8')
    migracoes.push({ versao, nome: String(partes[2]), sql, sha256: hashMigracao(sql) })
  }
  return migracoes.sort((a, b) => a.versao - b.versao)
}

/** Aplica o que falta, cada migração na sua transação, e devolve as versões aplicadas agora. */
export function aplicarMigracoes(arquivo: string, diretorio: string): number[] {
  const migracoes = lerMigracoes(diretorio)
  return comBanco(arquivo, (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS _migracoes (
      versao INTEGER PRIMARY KEY,
      nome TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      aplicada_em TEXT NOT NULL
    )`)
    const ler = db.prepare('SELECT sha256 FROM _migracoes WHERE versao = ?')
    const registrar = db.prepare('INSERT INTO _migracoes (versao, nome, sha256, aplicada_em) VALUES (?, ?, ?, ?)')
    const aplicadas: number[] = []
    for (const migracao of migracoes) {
      // Relê dentro da trava: outro processo pode ter aplicado entre a leitura e o BEGIN.
      const aplicou = transacao(db, () => {
        const existente = ler.get(migracao.versao) as { sha256: string } | undefined
        if (existente) {
          if (existente.sha256 !== migracao.sha256) {
            throw new Error(`Migração ${migracao.versao} (${migracao.nome}) mudou depois de aplicada; crie uma migração nova.`)
          }
          return false
        }
        db.exec(migracao.sql)
        registrar.run(migracao.versao, migracao.nome, migracao.sha256, new Date().toISOString())
        return true
      })
      if (aplicou) aplicadas.push(migracao.versao)
    }
    return aplicadas
  })
}
