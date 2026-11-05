import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { aplicarMigracoes, hashMigracao } from '../src/infrastructure/database/sqlite/migracoes.js'

const pastas: string[] = []
after(async () => { await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true }))) })

async function cenario(arquivos: Record<string, string>): Promise<{ banco: string; diretorio: string }> {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-migracoes-'))
  pastas.push(pasta)
  const diretorio = join(pasta, 'migrations-sqlite')
  await mkdir(diretorio)
  for (const [nome, sql] of Object.entries(arquivos)) await writeFile(join(diretorio, nome), sql)
  return { banco: join(pasta, 'overcore.db'), diretorio }
}

const PRIMEIRA = 'CREATE TABLE a (id INTEGER PRIMARY KEY);\n'
const SEGUNDA = 'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL REFERENCES a(id));\n'

test('aplica em ordem de versão e registra nome e hash', async () => {
  const { banco, diretorio } = await cenario({ '0002_b.sql': SEGUNDA, '0001_a.sql': PRIMEIRA })
  assert.deepEqual(aplicarMigracoes(banco, diretorio), [1, 2])
  const linhas = comBanco(banco, (db) => db.prepare('SELECT versao, nome, sha256, aplicada_em FROM _migracoes ORDER BY versao').all())
  assert.deepEqual(linhas.map((linha) => [linha.versao, linha.nome, linha.sha256]), [
    [1, 'a', hashMigracao(PRIMEIRA)],
    [2, 'b', hashMigracao(SEGUNDA)]
  ])
  for (const linha of linhas) assert.match(String(linha.aplicada_em), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('segunda abertura não reaplica nada', async () => {
  const { banco, diretorio } = await cenario({ '0001_a.sql': PRIMEIRA })
  aplicarMigracoes(banco, diretorio)
  assert.deepEqual(aplicarMigracoes(banco, diretorio), [])
})

test('migração alterada depois de aplicada é recusada', async () => {
  const { banco, diretorio } = await cenario({ '0001_a.sql': PRIMEIRA })
  aplicarMigracoes(banco, diretorio)
  await writeFile(join(diretorio, '0001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);\n')
  assert.throws(() => aplicarMigracoes(banco, diretorio), /Migração 1 \(a\) mudou depois de aplicada; crie uma migração nova\./)
})

test('CRLF e LF produzem o mesmo hash: checkout em outra máquina não acusa alteração', async () => {
  assert.equal(hashMigracao('X;\r\nY;\r\n'), hashMigracao('X;\nY;\n'))
  const { banco, diretorio } = await cenario({ '0001_a.sql': PRIMEIRA })
  aplicarMigracoes(banco, diretorio)
  await writeFile(join(diretorio, '0001_a.sql'), PRIMEIRA.replace(/\n/g, '\r\n'))
  assert.deepEqual(aplicarMigracoes(banco, diretorio), [])
})

test('nome fora do padrão é erro e arquivo que não é SQL é ignorado', async () => {
  const ruim = await cenario({ '0001_a.sql': PRIMEIRA, '2_b.sql': SEGUNDA })
  assert.throws(() => aplicarMigracoes(ruim.banco, ruim.diretorio), /Nome de migração fora do padrão NNNN_nome\.sql: 2_b\.sql/)
  const duplicada = await cenario({ '0001_a.sql': PRIMEIRA, '0001_b.sql': SEGUNDA })
  assert.throws(() => aplicarMigracoes(duplicada.banco, duplicada.diretorio), /Versão de migração repetida: 1/)
  const comNota = await cenario({ '0001_a.sql': PRIMEIRA, 'EQUIVALENCIA.md': '# nota\n' })
  assert.deepEqual(aplicarMigracoes(comNota.banco, comNota.diretorio), [1])
})

test('migração que falha no meio não deixa tabela nem registro', async () => {
  const { banco, diretorio } = await cenario({
    '0001_a.sql': PRIMEIRA,
    '0002_quebrada.sql': 'CREATE TABLE c (id INTEGER PRIMARY KEY);\nINSERT INTO tabela_que_nao_existe VALUES (1);\n'
  })
  assert.throws(() => aplicarMigracoes(banco, diretorio), /tabela_que_nao_existe/)
  const estado = comBanco(banco, (db) => ({
    versoes: db.prepare('SELECT versao FROM _migracoes ORDER BY versao').all().map((linha) => linha.versao),
    tabelaC: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='c'").get()?.n
  }))
  assert.deepEqual(estado, { versoes: [1], tabelaC: 0 })
})
