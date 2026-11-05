import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { abrirBanco, comBanco, transacao } from '../src/infrastructure/database/sqlite/banco.js'

const pastas: string[] = []
after(async () => { await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true }))) })

async function arquivoTemporario(): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-sqlite-'))
  pastas.push(pasta)
  return join(pasta, 'overcore.db')
}

function criarTabela(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, valor TEXT NOT NULL)')
}

function contar(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n)
}

test('abertura aplica os pragmas do molde e eles são lidos de volta', async () => {
  const db = abrirBanco(await arquivoTemporario())
  try {
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal')
    assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000)
    assert.equal((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous, 1)
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)
  } finally { db.close() }
})

test('transação síncrona confirma o trabalho e devolve o resultado', async () => {
  const arquivo = await arquivoTemporario()
  const resultado = comBanco(arquivo, (db) => {
    criarTabela(db)
    return transacao(db, () => { db.prepare('INSERT INTO t (valor) VALUES (?)').run('a'); return 'feito' })
  })
  assert.equal(resultado, 'feito')
  assert.equal(comBanco(arquivo, contar), 1)
})

test('erro dentro da transação desfaz o trabalho', async () => {
  const arquivo = await arquivoTemporario()
  comBanco(arquivo, criarTabela)
  assert.throws(() => comBanco(arquivo, (db) => transacao(db, () => {
    db.prepare('INSERT INTO t (valor) VALUES (?)').run('a')
    throw new Error('falhou no meio')
  })), /falhou no meio/)
  assert.equal(comBanco(arquivo, contar), 0)
})

test('transação que devolve Promise é recusada e desfeita', async () => {
  const arquivo = await arquivoTemporario()
  comBanco(arquivo, criarTabela)
  assert.throws(() => comBanco(arquivo, (db) => transacao(db, async () => {
    db.prepare('INSERT INTO t (valor) VALUES (?)').run('a')
  })), /Transação do banco não pode ser assíncrona/)
  assert.equal(comBanco(arquivo, contar), 0)
})

test('transação aninhada é recusada', async () => {
  const arquivo = await arquivoTemporario()
  assert.throws(
    () => comBanco(arquivo, (db) => transacao(db, () => transacao(db, () => 1))),
    /Transação aninhada/
  )
})

test('comBanco fecha a conexão mesmo no erro e recusa trabalho assíncrono', async () => {
  const arquivo = await arquivoTemporario()
  let aberta: DatabaseSync | undefined
  assert.throws(() => comBanco(arquivo, (db) => { aberta = db; throw new Error('quebrou') }), /quebrou/)
  assert.equal(aberta?.isOpen, false)
  assert.throws(() => comBanco(arquivo, async () => 1), /Uso do banco não pode ser assíncrono/)
})
