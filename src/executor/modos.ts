// Os modos do sub-executor do Overcore na casa única (ADR-024): instalar, atualizar e verificar.
// O executor do Omni chama a CLI (overcore-executor.ts); a lógica mora aqui para o teste chamar em processo.
//
// Regras:
// - o banco é `overcore.db` em OMNI_CASA_BANCO, senão em %LOCALAPPDATA%\omni\casa. Este é o único lugar
//   que indica o arquivo da casa (ADR-023 D1); com NODE_TEST_CONTEXT, a casa real é recusada antes de
//   qualquer arquivo ser criado;
// - migração pendente com o Overcore servindo é recusada: o esquema não muda por baixo de um processo vivo;
// - verificar só lê.
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { aplicarMigracoes, lerMigracoes, nomeDaMigracao, situacaoDasMigracoes } from '../infrastructure/database/sqlite/migracoes.js'
import { donoVivo } from '../infrastructure/database/sqlite/posse.js'

export const ARQUIVO_DO_BANCO = 'overcore.db'

export class ErroExecutor extends Error {}

type Ambiente = Record<string, string | undefined>

/** A raiz do pacote, achada pelo package.json: `dist/` e `.test-dist/src/` ficam em alturas diferentes. */
export function raizDoPacote(de: string = dirname(fileURLToPath(import.meta.url))): string {
  for (let pasta = de; ; pasta = dirname(pasta)) {
    const pacote = join(pasta, 'package.json')
    if (existsSync(pacote) && (JSON.parse(readFileSync(pacote, 'utf8')) as { name?: string }).name === 'overcore') return pasta
    if (dirname(pasta) === pasta) throw new Error('Raiz do pacote overcore não encontrada.')
  }
}

export const pastaDeMigracoes = (): string => join(raizDoPacote(), 'migrations-sqlite')
export const versaoDoPacote = (): string =>
  (JSON.parse(readFileSync(join(raizDoPacote(), 'package.json'), 'utf8')) as { version: string }).version

const localAppData = (env: Ambiente): string => env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')

export function casaDoBanco(env: Ambiente = process.env): string {
  const pasta = resolve(env.OMNI_CASA_BANCO || join(localAppData(env), 'omni', 'casa'))
  if (env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) {
    const reais = [env.LOCALAPPDATA, process.env.LOCALAPPDATA, join(homedir(), 'AppData', 'Local')]
      .filter((p): p is string => Boolean(p)).map((p) => resolve(p, 'omni', 'casa').toLowerCase())
    if (reais.includes(pasta.toLowerCase())) {
      throw new ErroExecutor('em teste, a casa real é recusada: defina OMNI_CASA_BANCO numa pasta temporária')
    }
  }
  return pasta
}

export function bancoInstalado(env: Ambiente = process.env): string {
  const arquivo = join(casaDoBanco(env), ARQUIVO_DO_BANCO)
  if (!existsSync(arquivo)) throw new ErroExecutor('o Overcore não está instalado nesta casa: rode instalar antes')
  return arquivo
}

/** Se alguém segura a posse, o Overcore está servindo neste banco. */
export function recusarSeServindo(arquivo: string, acao: string): void {
  const dono = donoVivo(arquivo)
  if (dono) throw new ErroExecutor(`o Overcore está servindo neste banco (processo ${dono.processo} em ${dono.maquina}): pare antes de ${acao}`)
}

interface Opcoes { env?: Ambiente; pastaMigracoes?: string }

/** Aplica só o que falta. Sem pendência, nem abre o banco para escrita. */
function migrar(arquivo: string, pastaMigracoes: string, acao: string): { aplicadas: string[]; atual: string | null } {
  const antes = situacaoDasMigracoes(arquivo, pastaMigracoes)
  if (antes.alteradas.length) throw new ErroExecutor(`migração alterada depois de aplicada (${antes.alteradas.join(', ')}): crie uma migração nova`)
  if (antes.pendentes.length) {
    recusarSeServindo(arquivo, acao)
    aplicarMigracoes(arquivo, pastaMigracoes)
  }
  const depois = situacaoDasMigracoes(arquivo, pastaMigracoes).aplicadas
  return { aplicadas: depois.filter((v) => !antes.aplicadas.includes(v)), atual: depois.at(-1) ?? null }
}

// ── instalar ────────────────────────────────────────────────────────────────────────────────────────
/** Banco vazio e migrado, pronto para receber. Duas vezes: nada muda. */
export function instalar({ env = process.env, pastaMigracoes = pastaDeMigracoes() }: Opcoes = {}) {
  const pasta = casaDoBanco(env)
  const arquivo = join(pasta, ARQUIVO_DO_BANCO)
  const novo = !existsSync(arquivo)
  if (novo) {
    mkdirSync(pasta, { recursive: true })
    aplicarMigracoes(arquivo, pastaMigracoes)
    const aplicadas = situacaoDasMigracoes(arquivo, pastaMigracoes).aplicadas
    return { ok: true as const, modo: 'instalar' as const, banco: arquivo, novo, migracoes: { aplicadas, atual: aplicadas.at(-1) ?? null } }
  }
  return { ok: true as const, modo: 'instalar' as const, banco: arquivo, novo, migracoes: migrar(arquivo, pastaMigracoes, 'instalar') }
}

// ── atualizar ───────────────────────────────────────────────────────────────────────────────────────
export function atualizar({ env = process.env, pastaMigracoes = pastaDeMigracoes() }: Opcoes = {}) {
  const arquivo = bancoInstalado(env)
  return { ok: true as const, modo: 'atualizar' as const, ...migrar(arquivo, pastaMigracoes, 'atualizar') }
}

// ── impressão: contagem e hash por tabela ───────────────────────────────────────────────────────────
// Igual à do Oráculo: linhas em ordem de chave primária (ou de todas as colunas), cada uma como JSON dos
// valores na ordem das colunas. A posse (_dono) fica de fora: é desta máquina e não viaja no pacote.
export const MANIFESTO = 'manifesto.json'
const POSSE = '_dono'

export type Impressao = Record<string, { linhas: number; sha256: string }>

const temTabela = (db: DatabaseSync, nome: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nome))
const normal = (v: unknown): unknown =>
  v instanceof Uint8Array ? { hex: Buffer.from(v).toString('hex') } : typeof v === 'bigint' ? String(v) : v
const aspas = (nome: string): string => `"${nome.replace(/"/g, '""')}"`

export function impressao(db: DatabaseSync): Impressao {
  const tabelas = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map((l) => l.name).filter((n) => n !== POSSE)
  const r: Impressao = {}
  for (const t of tabelas) {
    const colunas = db.prepare(`PRAGMA table_info(${aspas(t)})`).all() as { name: string; pk: number }[]
    const chave = colunas.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
    const lista = colunas.map((c) => aspas(c.name)).join(', ')
    const ordem = (chave.length ? chave : colunas.map((c) => c.name)).map(aspas).join(', ')
    const h = createHash('sha256')
    let linhas = 0
    for (const l of db.prepare(`SELECT ${lista} FROM ${aspas(t)} ORDER BY ${ordem}`).iterate()) {
      h.update(`${JSON.stringify(Object.values(l as Record<string, unknown>).map(normal))}\n`)
      linhas += 1
    }
    r[t] = { linhas, sha256: h.digest('hex') }
  }
  return r
}

function compararTabelas(esperado: Impressao, atual: Impressao) {
  const nomes = [...new Set([...Object.keys(esperado), ...Object.keys(atual)])].sort()
  const diferentes = nomes.filter((n) => esperado[n]?.sha256 !== atual[n]?.sha256 || esperado[n]?.linhas !== atual[n]?.linhas)
  return { total: nomes.length, iguais: nomes.length - diferentes.length, diferentes }
}

/** Dado de domínio: o Overcore não apaga por marca, então toda linha de overcore_* é viva. */
function linhasVivas(db: DatabaseSync): number {
  const tabelas = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'overcore\\_%' ESCAPE '\\'").all() as { name: string }[])
  return tabelas.reduce((n, { name }) => n + Number((db.prepare(`SELECT count(*) AS n FROM ${aspas(name)}`).get() as { n: number }).n), 0)
}

const migracoesDe = (db: DatabaseSync): string[] =>
  temTabela(db, '_migracoes')
    ? (db.prepare('SELECT versao, nome FROM _migracoes ORDER BY versao').all() as { versao: number; nome: string }[]).map(nomeDaMigracao)
    : []

function comLeitura<T>(arquivo: string, fazer: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(arquivo, { readOnly: true })
  try {
    return fazer(db)
  } finally {
    db.close()
  }
}

// ── exportar ────────────────────────────────────────────────────────────────────────────────────────
// VACUUM INTO num pacote novo (pasta com overcore.db + manifesto.json), com o banco da casa aberto só para
// leitura: funciona com o Overcore servindo. A cópia perde a posse; o VACUUM INTO já a escreve em journal
// DELETE, então o pacote é um arquivo só, sem -wal nem -shm.
const carimbo = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

export function exportar({ env = process.env, destino, agora = Date.now(), maquina = hostname() }:
  { env?: Ambiente; destino?: string | undefined; agora?: number; maquina?: string } = {}) {
  const arquivo = bancoInstalado(env)
  const base = resolve(destino ?? join(casaDoBanco(env), 'exportacoes'))
  const pacote = join(base, `overcore-${carimbo(agora)}-${randomBytes(3).toString('hex')}`)
  mkdirSync(pacote, { recursive: true })
  const alvo = join(pacote, ARQUIVO_DO_BANCO)
  comLeitura(arquivo, (db) => { db.prepare('VACUUM INTO ?').run(alvo) })

  const copia = new DatabaseSync(alvo)
  let manifesto: { agente: 'overcore'; versao: string; migracao: string | null; migracoes: string[]; maquina: string; criadoEm: string; tabelas: Impressao }
  try {
    if (temTabela(copia, POSSE)) {
      copia.exec('PRAGMA secure_delete = ON')
      copia.exec(`DELETE FROM ${POSSE}`)
      copia.exec('VACUUM')
    }
    const migracoes = migracoesDe(copia)
    manifesto = {
      agente: 'overcore',
      versao: versaoDoPacote(),
      migracao: migracoes.at(-1) ?? null,
      migracoes,
      maquina,
      criadoEm: new Date(agora).toISOString(),
      tabelas: impressao(copia)
    }
  } finally {
    copia.close()
  }
  writeFileSync(join(pacote, MANIFESTO), `${JSON.stringify(manifesto, null, 2)}\n`)
  const linhas = Object.values(manifesto.tabelas).reduce((n, t) => n + t.linhas, 0)
  return { ok: true as const, modo: 'exportar' as const, pacote, migracao: manifesto.migracao, tabelas: Object.keys(manifesto.tabelas).length, linhas }
}

/** Lê e confere o pacote: o banco dele tem que bater com o próprio manifesto. */
export function lerPacote(pasta: string): { manifesto: { tabelas: Impressao }; arquivo: string; migracoes: string[] } {
  let manifesto: { agente?: unknown; tabelas?: unknown }
  try {
    manifesto = JSON.parse(readFileSync(join(pasta, MANIFESTO), 'utf8')) as typeof manifesto
  } catch {
    throw new ErroExecutor('pacote sem manifesto.json legível')
  }
  if (manifesto?.agente !== 'overcore' || !manifesto.tabelas || typeof manifesto.tabelas !== 'object') {
    throw new ErroExecutor('manifesto não é de um pacote do Overcore')
  }
  const tabelas = manifesto.tabelas as Impressao
  const arquivo = join(pasta, ARQUIVO_DO_BANCO)
  if (!existsSync(arquivo)) throw new ErroExecutor(`pacote sem ${ARQUIVO_DO_BANCO}`)
  return comLeitura(arquivo, (db) => {
    const { diferentes } = compararTabelas(tabelas, impressao(db))
    if (diferentes.length) throw new ErroExecutor(`o banco do pacote não bate com o manifesto: ${diferentes.join(', ')}`)
    return { manifesto: { tabelas }, arquivo, migracoes: migracoesDe(db) }
  })
}

// ── importar ────────────────────────────────────────────────────────────────────────────────────────
// Só numa casa sem dado vivo e sem o Overcore servindo; o mesmo pacote de novo não muda nada. A troca do
// arquivo só acontece depois de a cópia abrir e migrar sem erro.
export function importar({ env = process.env, pacote, pastaMigracoes = pastaDeMigracoes() }:
  Opcoes & { pacote?: string | undefined } = {}) {
  if (!pacote) throw new ErroExecutor('importar: diga a pasta do pacote')
  const { manifesto, arquivo: origem, migracoes: doPacote } = lerPacote(resolve(pacote))
  const conhecidas = new Set(lerMigracoes(pastaMigracoes).map(nomeDaMigracao))
  const novas = doPacote.filter((m) => !conhecidas.has(m))
  if (novas.length) throw new ErroExecutor(`o pacote vem de um Overcore mais novo (migrações ${novas.join(', ')}): atualize o código antes`)

  const pasta = casaDoBanco(env)
  const arquivo = join(pasta, ARQUIVO_DO_BANCO)
  if (existsSync(arquivo)) {
    const igual = comLeitura(arquivo, (db) => compararTabelas(manifesto.tabelas, impressao(db)).diferentes.length === 0)
    if (igual) return { ok: true as const, modo: 'importar' as const, origem: 'pacote' as const, banco: arquivo, nadaMudou: true as const }
    recusarSeServindo(arquivo, 'importar')
    const vivas = comLeitura(arquivo, linhasVivas)
    if (vivas > 0) throw new ErroExecutor(`o banco desta casa já tem ${vivas} linhas vivas: pacote só entra em banco vazio`)
  }

  mkdirSync(pasta, { recursive: true })
  const temp = join(pasta, `${ARQUIVO_DO_BANCO}.importando-${randomBytes(3).toString('hex')}`)
  const limparTemp = () => { for (const s of ['', '-wal', '-shm']) rmSync(temp + s, { force: true }) }
  let aplicadas: string[]
  try {
    copyFileSync(origem, temp)
    aplicarMigracoes(temp, pastaMigracoes) // migração do pacote diferente da daqui: recusa, e o banco atual fica
    aplicadas = situacaoDasMigracoes(temp, pastaMigracoes).aplicadas.filter((m) => !doPacote.includes(m))
  } catch (error) {
    limparTemp()
    throw error
  }
  for (const s of ['', '-wal', '-shm']) rmSync(arquivo + s, { force: true })
  renameSync(temp, arquivo)
  limparTemp()
  const linhas = Object.values(manifesto.tabelas).reduce((n, t) => n + t.linhas, 0)
  return {
    ok: true as const, modo: 'importar' as const, origem: 'pacote' as const, banco: arquivo, nadaMudou: false as const,
    tabelas: Object.keys(manifesto.tabelas).length, linhas, migracoes: { aplicadas }
  }
}

// ── verificar ───────────────────────────────────────────────────────────────────────────────────────
export interface Verificacao { nome: string; ok: boolean; [detalhe: string]: unknown }

function statusSemToken(porta: number): Promise<number | null> {
  return new Promise((resolver) => {
    const pedido = request({ host: '127.0.0.1', port: porta, method: 'GET', path: '/v1/saude', timeout: 3000 }, (resposta) => {
      resposta.resume()
      resolver(resposta.statusCode ?? null)
    })
    pedido.on('timeout', () => pedido.destroy())
    pedido.on('error', () => resolver(null))
    pedido.end()
  })
}

export async function verificar({ env = process.env, pastaMigracoes = pastaDeMigracoes(), porta, pacote }:
  Opcoes & { porta?: number | undefined; pacote?: string | undefined } = {}) {
  const arquivo = bancoInstalado(env)
  const verificacoes: Verificacao[] = []
  const marcar = (nome: string, ok: boolean, detalhe: Record<string, unknown> = {}) => { verificacoes.push({ nome, ok, ...detalhe }) }
  const db = new DatabaseSync(arquivo, { readOnly: true })
  try {
    const valor = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0]
    marcar('integridade', valor('PRAGMA integrity_check') === 'ok')
    const violacoes = db.prepare('PRAGMA foreign_key_check').all().length
    marcar('chaves estrangeiras', violacoes === 0, { violacoes })
    const diario = valor('PRAGMA journal_mode')
    marcar('journal WAL', diario === 'wal', { valor: diario })
    if (pacote) {
      const c = compararTabelas(lerPacote(resolve(pacote)).manifesto.tabelas, impressao(db))
      marcar('pacote', c.diferentes.length === 0, { tabelas: c.total, iguais: c.iguais, diferentes: c.diferentes })
    }
  } finally {
    db.close()
  }
  const { pendentes, alteradas, desconhecidas } = situacaoDasMigracoes(arquivo, pastaMigracoes)
  marcar('migrações', !pendentes.length && !alteradas.length && !desconhecidas.length, { pendentes, alteradas, desconhecidas })
  if (porta !== undefined) {
    const status = await statusSemToken(porta)
    marcar('API', status === 401, {
      porta, status,
      leitura: status === 401 ? 'de pé e fechada sem token' : status === null ? 'não respondeu' : 'respondeu sem exigir token'
    })
  }
  return { ok: verificacoes.every((v) => v.ok), modo: 'verificar' as const, verificacoes }
}

// ── servir ──────────────────────────────────────────────────────────────────────────────────────────
export interface Servindo {
  ok: true
  porta: number
  /** Idempotente: fecha o servidor e solta a posse do banco. */
  parar(): Promise<void>
}

/**
 * Sobe o Overcore no banco da casa, só em 127.0.0.1, com toda rota exigindo o token de OVERCORE_LOCAL_TOKEN.
 * Quem migra é o atualizar, com o Overcore parado; aqui, banco fora do esquema do pacote é recusado.
 * O runtime entra por import dinâmico: instalar e verificar não carregam o SDK nem o servidor.
 */
export async function servir({ env = process.env, porta, aoPerderPosse, log }: {
  env?: Ambiente
  porta: number
  aoPerderPosse: (error: Error) => void
  log?: (texto: string) => void
}): Promise<Servindo> {
  const arquivo = bancoInstalado(env)
  const { pendentes, alteradas, desconhecidas } = situacaoDasMigracoes(arquivo, pastaDeMigracoes())
  if (pendentes.length) throw new ErroExecutor(`migração pendente (${pendentes.join(', ')}): rode atualizar antes de servir`)
  if (alteradas.length || desconhecidas.length) {
    throw new ErroExecutor(`o banco da casa diverge das migrações deste pacote (${[...alteradas, ...desconhecidas].join(', ')})`)
  }
  const { subir } = await import('../infrastructure/runtime/serve.js')
  const rodando = await subir(raizDoPacote(), {
    env: { ...env, OVERCORE_DATABASE_ENGINE: 'sqlite', OVERCORE_SQLITE_PATH: arquivo, OVERCORE_PORT: String(porta) },
    migracoes: 'exigir',
    healthAberto: false,
    aoPerderPosse,
    ...(log ? { log } : {})
  })
  return { ok: true, porta: rodando.porta, parar: () => rodando.encerrar() }
}

export { nomeDaMigracao }
