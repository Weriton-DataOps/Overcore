// Sub-executor da casa (ADR-024): instalar, atualizar e verificar, em processo e pela CLI.
// Tudo em pasta temporária. Com NODE_TEST_CONTEXT, a casa real é recusada antes de criar arquivo.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { tomarPosse } from '../src/infrastructure/database/sqlite/posse.js'
import { atualizar, ErroExecutor, instalar, raizDoPacote, verificar } from '../src/executor/modos.js'

const CLI = join(process.cwd(), '.test-dist', 'src', 'executor', 'overcore-executor.js')
// As migrações reais do pacote, em ordem; a nota de teste usa 9990 para ficar sempre depois delas.
const MIGRACOES = readdirSync(join(raizDoPacote(), 'migrations-sqlite'))
  .filter((nome) => /^\d{4}_.+\.sql$/.test(nome)).sort().map((nome) => nome.slice(0, -4))
const ULTIMA = MIGRACOES.at(-1)

function casa() {
  const pasta = mkdtempSync(join(tmpdir(), 'overcore-casa-'))
  const env = { OMNI_CASA_BANCO: join(pasta, 'casa'), LOCALAPPDATA: join(pasta, 'local') }
  return { pasta, env, arquivo: join(pasta, 'casa', 'overcore.db'), limpar: () => rmSync(pasta, { recursive: true, force: true }) }
}

function migracoesCopiadas(pasta: string): string {
  const destino = join(pasta, 'migracoes')
  cpSync(join(raizDoPacote(), 'migrations-sqlite'), destino, { recursive: true })
  return destino
}

test('instalar cria o banco migrado e, rodado de novo, não muda nada', async () => {
  const c = casa()
  try {
    const primeiro = instalar({ env: c.env })
    assert.deepEqual(primeiro, {
      ok: true, modo: 'instalar', banco: c.arquivo, novo: true,
      migracoes: { aplicadas: MIGRACOES, atual: ULTIMA }
    })
    const antes = readFileSync(c.arquivo)
    const segundo = instalar({ env: c.env })
    assert.deepEqual(segundo, {
      ok: true, modo: 'instalar', banco: c.arquivo, novo: false,
      migracoes: { aplicadas: [], atual: ULTIMA }
    })
    assert.deepEqual(readFileSync(c.arquivo), antes, 'o segundo instalar não tocou no arquivo')
    const v = await verificar({ env: c.env })
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.deepEqual(v.verificacoes.map((x) => [x.nome, x.ok]), [
      ['integridade', true], ['chaves estrangeiras', true], ['journal WAL', true], ['migrações', true]
    ])
  } finally { c.limpar() }
})

test('em teste, a casa real é recusada antes de qualquer arquivo ser criado', () => {
  const pasta = mkdtempSync(join(tmpdir(), 'overcore-casa-real-'))
  try {
    assert.throws(() => instalar({ env: { LOCALAPPDATA: pasta } }), (e: unknown) =>
      e instanceof ErroExecutor && /casa real/.test(e.message))
    assert.equal(existsSync(join(pasta, 'omni')), false)
  } finally { rmSync(pasta, { recursive: true, force: true }) }
})

test('atualizar e verificar exigem a casa instalada', async () => {
  const c = casa()
  try {
    assert.throws(() => atualizar({ env: c.env }), (e: unknown) => e instanceof ErroExecutor && /instalar/.test(e.message))
    await assert.rejects(verificar({ env: c.env }), (e: unknown) => e instanceof ErroExecutor && /instalar/.test(e.message))
    assert.equal(existsSync(c.arquivo), false)
  } finally { c.limpar() }
})

test('migração nova fica pendente no verificar até o atualizar; alterada é acusada', async () => {
  const c = casa()
  try {
    const pastaMigracoes = migracoesCopiadas(c.pasta)
    instalar({ env: c.env, pastaMigracoes })
    writeFileSync(join(pastaMigracoes, '9990_nota.sql'), 'CREATE TABLE nota (id INTEGER PRIMARY KEY);\n')

    const pendente = await verificar({ env: c.env, pastaMigracoes })
    assert.equal(pendente.ok, false)
    assert.deepEqual(pendente.verificacoes.find((x) => x.nome === 'migrações'),
      { nome: 'migrações', ok: false, pendentes: ['9990_nota'], alteradas: [], desconhecidas: [] })

    assert.deepEqual(atualizar({ env: c.env, pastaMigracoes }), { ok: true, modo: 'atualizar', aplicadas: ['9990_nota'], atual: '9990_nota' })
    assert.deepEqual(atualizar({ env: c.env, pastaMigracoes }), { ok: true, modo: 'atualizar', aplicadas: [], atual: '9990_nota' })
    assert.equal((await verificar({ env: c.env, pastaMigracoes })).ok, true)

    writeFileSync(join(pastaMigracoes, '9990_nota.sql'), 'CREATE TABLE nota (id INTEGER PRIMARY KEY, texto TEXT);\n')
    const alterada = await verificar({ env: c.env, pastaMigracoes })
    assert.deepEqual(alterada.verificacoes.find((x) => x.nome === 'migrações'),
      { nome: 'migrações', ok: false, pendentes: [], alteradas: ['9990_nota'], desconhecidas: [] })
  } finally { c.limpar() }
})

test('com o Overcore servindo, migração pendente é recusada em vez de mudar o esquema por baixo dele', () => {
  const c = casa()
  try {
    const pastaMigracoes = migracoesCopiadas(c.pasta)
    instalar({ env: c.env, pastaMigracoes })
    tomarPosse(c.arquivo, { processo: '4242', maquina: 'OUTRA' })
    assert.deepEqual(instalar({ env: c.env, pastaMigracoes }).migracoes.aplicadas, [], 'sem pendência, instalar segue idempotente')
    writeFileSync(join(pastaMigracoes, '9990_nota.sql'), 'CREATE TABLE nota (id INTEGER PRIMARY KEY);\n')
    for (const modo of [() => atualizar({ env: c.env, pastaMigracoes }), () => instalar({ env: c.env, pastaMigracoes })]) {
      assert.throws(modo, (e: unknown) => e instanceof ErroExecutor && /servindo/.test(e.message) && /4242/.test(e.message))
    }
  } finally { c.limpar() }
})

test('a CLI devolve uma linha de JSON: 0 no sucesso, 1 na recusa, 2 no uso errado', () => {
  const c = casa()
  const rodar = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...c.env }, encoding: 'utf8' })
    const linhas = r.stdout.split('\n').filter(Boolean)
    assert.equal(linhas.length, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`)
    return { codigo: r.status, saida: JSON.parse(linhas[0] ?? '{}') as Record<string, unknown> }
  }
  try {
    const recusa = rodar('verificar')
    assert.equal(recusa.codigo, 1)
    assert.equal(recusa.saida.ok, false)
    assert.equal(recusa.saida.recusa, true)

    const inst = rodar('instalar')
    assert.equal(inst.codigo, 0)
    assert.equal(inst.saida.modo, 'instalar')
    assert.equal(rodar('verificar').codigo, 0)

    for (const errado of [['voar'], [], ['instalar', 'sobrando'], ['verificar', '--nada']]) {
      const r = rodar(...errado)
      assert.equal(r.codigo, 2, errado.join(' '))
      assert.equal(r.saida.ok, false)
      assert.match(String(r.saida.uso), /^uso: overcore-executor/)
    }
  } finally { c.limpar() }
})

test('executor/agente.json segue o contrato da casa e tem a versão do pacote', () => {
  const raiz = raizDoPacote()
  const agente = JSON.parse(readFileSync(join(raiz, 'executor', 'agente.json'), 'utf8')) as Record<string, unknown>
  const pacote = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8')) as { version: string }
  assert.equal(agente.agente, 'overcore')
  assert.equal(agente.versao, pacote.version)
  assert.equal(agente.banco, 'overcore.db')
  assert.equal(agente.migracoes, 'migrations-sqlite/')
  assert.deepEqual(agente.requer, { node: '>=24', agentes: ['omni>=0.26'] })
  assert.deepEqual(agente.executor, {
    comando: 'node dist/executor/overcore-executor.js',
    modos: ['instalar', 'importar', 'exportar', 'atualizar', 'verificar', 'servir']
  })
  const interfaceDoAgente = agente.interface as Record<string, unknown>
  assert.equal(interfaceDoAgente.modulo, 'interface/index.html')
  assert.equal(interfaceDoAgente.painel, 'Overcore')
  assert.equal(interfaceDoAgente.api, 'http://127.0.0.1:{porta}/v1')
  assert.deepEqual(agente.tarefas, [])
  assert.deepEqual(agente.credenciais, [])
})
