// F4, bloco E (E3): exportar e importar o banco da casa num pacote no formato do Oráculo
// (pasta com overcore.db + manifesto.json). A posse (_dono) é desta máquina: não viaja e não entra na impressão.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

import { ErroExecutor, exportar, importar, instalar, raizDoPacote, verificar } from '../src/executor/modos.js'
import { tomarPosse } from '../src/infrastructure/database/sqlite/posse.js'

const CLI = join(process.cwd(), '.test-dist', 'src', 'executor', 'overcore-executor.js')
const pastas: string[] = []
after(() => { for (const pasta of pastas) rmSync(pasta, { recursive: true, force: true }) })

function casa() {
  const pasta = mkdtempSync(join(tmpdir(), 'overcore-pacote-'))
  pastas.push(pasta)
  const env = { OMNI_CASA_BANCO: join(pasta, 'casa'), LOCALAPPDATA: join(pasta, 'local') }
  return { pasta, env, arquivo: join(pasta, 'casa', 'overcore.db') }
}

const AGORA = '2026-11-05T12:00:00.000Z'

function semear(arquivo: string, id: string): void {
  const db = new DatabaseSync(arquivo)
  try {
    db.prepare(`INSERT INTO overcore_preflight_streams
      (draft_id, idempotency_key, latest_revision, latest_report_id, status, created_at, updated_at, origem_maquina)
      VALUES (?, ?, 1, ?, 'ready', ?, ?, 'ORIGEM')`).run(id, `chave-${id}`, `relatorio-${id}`, AGORA, AGORA)
  } finally {
    db.close()
  }
}

const contar = (arquivo: string, tabela: string): number => {
  const db = new DatabaseSync(arquivo, { readOnly: true })
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM ${tabela}`).get() as { n: number }).n)
  } finally {
    db.close()
  }
}

test('exportar leva o banco sem a posse; importar numa casa nova repõe, e o mesmo pacote de novo não muda nada', async () => {
  const a = casa()
  instalar({ env: a.env })
  semear(a.arquivo, 'rascunho-1')
  tomarPosse(a.arquivo, { processo: '4242', maquina: 'ORIGEM' }) // servindo: exportar só lê, então pode

  const destino = join(a.pasta, 'saida')
  const exportado = exportar({ env: a.env, destino })
  assert.equal(exportado.ok, true)
  assert.equal(exportado.modo, 'exportar')
  assert.equal(exportado.migracao, '0001_overcore')
  assert.match(exportado.pacote, /overcore-\d{8}T\d{6}Z-[0-9a-f]{6}$/)
  assert.deepEqual(readdirSync(destino), [exportado.pacote.split(/[\\/]/).at(-1)])
  assert.deepEqual(readdirSync(exportado.pacote).sort(), ['manifesto.json', 'overcore.db'])

  const manifesto = JSON.parse(readFileSync(join(exportado.pacote, 'manifesto.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(manifesto), ['agente', 'versao', 'migracao', 'migracoes', 'maquina', 'criadoEm', 'tabelas'])
  assert.equal(manifesto.agente, 'overcore')
  assert.equal(manifesto.versao, (JSON.parse(readFileSync(join(raizDoPacote(), 'package.json'), 'utf8')) as { version: string }).version)
  assert.deepEqual(manifesto.migracoes, ['0001_overcore'])
  const tabelas = manifesto.tabelas as Record<string, { linhas: number; sha256: string }>
  assert.equal(tabelas._dono, undefined, 'a posse não entra na impressão')
  assert.equal(tabelas.overcore_preflight_streams?.linhas, 1)
  assert.equal(tabelas._diario?.linhas, 1, 'o diário viaja com o dado')
  assert.equal(exportado.tabelas, Object.keys(tabelas).length)
  assert.equal(contar(join(exportado.pacote, 'overcore.db'), '_dono'), 0, 'a posse não viaja')
  const doPacote = new DatabaseSync(join(exportado.pacote, 'overcore.db'), { readOnly: true })
  try {
    assert.equal(doPacote.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete', 'pacote num arquivo só')
  } finally {
    doPacote.close()
  }
  assert.equal(contar(a.arquivo, '_dono'), 1, 'exportar não mexe no banco de origem')

  const b = casa()
  const importado = importar({ env: b.env, pacote: exportado.pacote })
  assert.deepEqual(importado, {
    ok: true, modo: 'importar', origem: 'pacote', banco: b.arquivo, nadaMudou: false,
    tabelas: exportado.tabelas, linhas: exportado.linhas, migracoes: { aplicadas: [] }
  })
  assert.equal(contar(b.arquivo, 'overcore_preflight_streams'), 1)
  assert.deepEqual(readdirSync(join(b.pasta, 'casa')).filter((n) => n.includes('importando')), [], 'sem temporário largado')

  const bytes = readFileSync(b.arquivo)
  assert.deepEqual(importar({ env: b.env, pacote: exportado.pacote }), { ok: true, modo: 'importar', origem: 'pacote', banco: b.arquivo, nadaMudou: true })
  assert.deepEqual(readFileSync(b.arquivo), bytes)

  const vista = await verificar({ env: b.env, pacote: exportado.pacote })
  assert.equal(vista.ok, true, JSON.stringify(vista))
  assert.deepEqual(vista.verificacoes.find((v) => v.nome === 'pacote'),
    { nome: 'pacote', ok: true, tabelas: Object.keys(tabelas).length, iguais: Object.keys(tabelas).length, diferentes: [] })
  semear(b.arquivo, 'rascunho-2')
  const divergente = await verificar({ env: b.env, pacote: exportado.pacote })
  assert.equal(divergente.ok, false)
  assert.deepEqual(divergente.verificacoes.find((v) => v.nome === 'pacote')?.diferentes,
    ['_diario', 'overcore_preflight_streams'])
})

test('importar recusa casa com dado vivo, casa servindo, pacote adulterado e pacote de um Overcore mais novo', () => {
  const a = casa()
  instalar({ env: a.env })
  semear(a.arquivo, 'rascunho-1')
  const { pacote } = exportar({ env: a.env, destino: join(a.pasta, 'saida') })

  const viva = casa()
  instalar({ env: viva.env })
  semear(viva.arquivo, 'outro')
  assert.throws(() => importar({ env: viva.env, pacote }), (e: unknown) => e instanceof ErroExecutor && /1 linhas vivas/.test(e.message))
  assert.equal(contar(viva.arquivo, 'overcore_preflight_streams'), 1)

  const servindo = casa()
  instalar({ env: servindo.env })
  tomarPosse(servindo.arquivo, { processo: '4242', maquina: 'OUTRA' })
  assert.throws(() => importar({ env: servindo.env, pacote }), (e: unknown) => e instanceof ErroExecutor && /servindo/.test(e.message) && /4242/.test(e.message))

  const adulterado = join(a.pasta, 'adulterado')
  cpSync(pacote, adulterado, { recursive: true })
  semear(join(adulterado, 'overcore.db'), 'enxerto')
  const vazia = casa()
  assert.throws(() => importar({ env: vazia.env, pacote: adulterado }), (e: unknown) => e instanceof ErroExecutor && /não bate com o manifesto/.test(e.message))
  assert.equal(existsSync(vazia.arquivo), false)

  const semManifesto = join(a.pasta, 'sem-manifesto')
  cpSync(pacote, semManifesto, { recursive: true })
  rmSync(join(semManifesto, 'manifesto.json'))
  assert.throws(() => importar({ env: vazia.env, pacote: semManifesto }), (e: unknown) => e instanceof ErroExecutor && /manifesto/.test(e.message))
  const alheio = join(a.pasta, 'alheio')
  cpSync(pacote, alheio, { recursive: true })
  const m = JSON.parse(readFileSync(join(alheio, 'manifesto.json'), 'utf8')) as Record<string, unknown>
  writeFileSync(join(alheio, 'manifesto.json'), JSON.stringify({ ...m, agente: 'oraculo' }))
  assert.throws(() => importar({ env: vazia.env, pacote: alheio }), (e: unknown) => e instanceof ErroExecutor && /Overcore/.test(e.message))

  // um Overcore mais novo: a origem tem a 0002, que este pacote de código não conhece
  const nova = casa()
  const migracoes = join(nova.pasta, 'migracoes')
  cpSync(join(raizDoPacote(), 'migrations-sqlite'), migracoes, { recursive: true })
  writeFileSync(join(migracoes, '0002_nota.sql'), 'CREATE TABLE nota (id INTEGER PRIMARY KEY);\n')
  instalar({ env: nova.env, pastaMigracoes: migracoes })
  const doFuturo = exportar({ env: nova.env, destino: join(nova.pasta, 'saida') }).pacote
  assert.throws(() => importar({ env: vazia.env, pacote: doFuturo }), (e: unknown) => e instanceof ErroExecutor && /mais novo/.test(e.message) && /0002_nota/.test(e.message))
  assert.equal(existsSync(vazia.arquivo), false)
})

test('importar de um Overcore mais velho aplica a migração que falta e a casa fica no esquema deste pacote', () => {
  const velha = casa()
  const so1 = join(velha.pasta, 'so-1')
  cpSync(join(raizDoPacote(), 'migrations-sqlite'), so1, { recursive: true })
  instalar({ env: velha.env, pastaMigracoes: so1 })
  const { pacote } = exportar({ env: velha.env, destino: join(velha.pasta, 'saida') })

  const atual = join(velha.pasta, 'atual')
  cpSync(so1, atual, { recursive: true })
  writeFileSync(join(atual, '0002_nota.sql'), 'CREATE TABLE nota (id INTEGER PRIMARY KEY);\n')
  const b = casa()
  const r = importar({ env: b.env, pacote, pastaMigracoes: atual })
  assert.deepEqual(r.migracoes, { aplicadas: ['0002_nota'] })
  assert.equal(contar(b.arquivo, 'nota'), 0)
})

test('a CLI exporta, importa e verifica o pacote, uma linha de JSON por chamada', () => {
  const a = casa()
  const b = casa()
  const rodar = (args: string[], env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' })
    const linhas = r.stdout.split('\n').filter(Boolean)
    assert.equal(linhas.length, 1, `${args.join(' ')}: ${r.stdout} / ${r.stderr}`)
    return { codigo: r.status, json: JSON.parse(linhas[0] ?? '') as Record<string, unknown> }
  }
  assert.equal(rodar(['instalar'], a.env).codigo, 0)
  const exportado = rodar(['exportar', '--destino', join(a.pasta, 'saida')], a.env)
  assert.equal(exportado.codigo, 0)
  const pacote = String(exportado.json.pacote)
  assert.equal(rodar(['importar', pacote], b.env).codigo, 0)
  assert.equal(rodar(['importar', pacote], b.env).json.nadaMudou, true)
  assert.equal(rodar(['verificar', '--pacote', pacote], b.env).codigo, 0)
  for (const args of [['importar'], ['importar', pacote, 'sobra'], ['exportar', 'sobra']]) {
    const r = rodar(args, b.env)
    assert.equal(r.codigo, 2, args.join(' '))
    assert.match(String(r.json.uso), /^uso: overcore-executor/)
  }
})
