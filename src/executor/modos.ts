// Os modos do sub-executor do Overcore na casa única (ADR-024): instalar, atualizar e verificar.
// O executor do Omni chama a CLI (overcore-executor.ts); a lógica mora aqui para o teste chamar em processo.
//
// Regras:
// - o banco é `overcore.db` em OMNI_CASA_BANCO, senão em %LOCALAPPDATA%\omni\casa. Este é o único lugar
//   que indica o arquivo da casa (ADR-023 D1); com NODE_TEST_CONTEXT, a casa real é recusada antes de
//   qualquer arquivo ser criado;
// - migração pendente com o Overcore servindo é recusada: o esquema não muda por baixo de um processo vivo;
// - verificar só lê.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { aplicarMigracoes, nomeDaMigracao, situacaoDasMigracoes } from '../infrastructure/database/sqlite/migracoes.js'
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

export async function verificar({ env = process.env, pastaMigracoes = pastaDeMigracoes(), porta }: Opcoes & { porta?: number } = {}) {
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

export { nomeDaMigracao }
