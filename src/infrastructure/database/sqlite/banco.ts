import { DatabaseSync } from 'node:sqlite'

/**
 * Conexão SQLite no molde da casa única (ADR-023 D4): uma conexão por operação,
 * transação síncrona com BEGIN IMMEDIATE e nenhuma espera assíncrona dentro dela.
 * Reproduz o molde da casa, sem importá-lo.
 */

const SQLITE_BUSY = 5
const PRAZO_OCUPADO_MS = 5_000
const espera = new Int32Array(new SharedArrayBuffer(4))

function ocupado(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown }).errcode
  return typeof errcode === 'number' && (errcode & 0xff) === SQLITE_BUSY
}

function ehPromessa(valor: unknown): boolean {
  return typeof (valor as { then?: unknown } | null)?.then === 'function'
}

/** Repete a operação enquanto o banco estiver ocupado, com recuo exponencial e prazo fixo. */
export function insistirSeOcupado<T>(operacao: () => T): T {
  const limite = Date.now() + PRAZO_OCUPADO_MS
  for (let tentativa = 0; ; tentativa += 1) {
    try { return operacao() } catch (error) {
      if (!ocupado(error) || Date.now() >= limite) throw error
      Atomics.wait(espera, 0, 0, Math.min(5 * 2 ** tentativa, 100) * (0.5 + Math.random()))
    }
  }
}

export function abrirBanco(arquivo: string): DatabaseSync {
  const db = new DatabaseSync(arquivo)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    insistirSeOcupado(() => db.exec('PRAGMA journal_mode = WAL'))
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Abre, usa e fecha. O trabalho é síncrono: uma Promise aqui seguraria a conexão sem dono. */
export function comBanco<T>(arquivo: string, trabalho: (db: DatabaseSync) => T): T {
  const db = abrirBanco(arquivo)
  try {
    const resultado = trabalho(db)
    if (ehPromessa(resultado)) throw new Error('Uso do banco não pode ser assíncrono: a conexão fecharia antes do trabalho.')
    return resultado
  } finally {
    db.close()
  }
}

export function transacao<T>(db: DatabaseSync, trabalho: () => T): T {
  if (db.isTransaction) throw new Error('Transação aninhada não é permitida no banco do Overcore.')
  insistirSeOcupado(() => db.exec('BEGIN IMMEDIATE'))
  try {
    const resultado = trabalho()
    if (ehPromessa(resultado)) throw new Error('Transação do banco não pode ser assíncrona: abriria a trava durante espera externa.')
    db.exec('COMMIT')
    return resultado
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* a transação pode já ter sido encerrada pelo próprio SQLite */ }
    throw error
  }
}
