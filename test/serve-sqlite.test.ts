import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

import { ExecutorCapabilityCatalog, ExecutorCapabilityUnavailableError, localExecutorCapabilities } from '../src/application/executor-capability.js'
import { soltarPosse, tomarPosse } from '../src/infrastructure/database/sqlite/posse.js'
import { abrirPersistencia } from '../src/infrastructure/runtime/persistencia.js'

// F4, tarefa C3: o serve escolhe o motor. No SQLite ele migra, toma a posse do arquivo,
// não oferece a sonda PostgreSQL e, ao encerrar, solta a posse.

const pastas: string[] = []
after(async () => { await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true }))) })

async function pastaTemporaria(): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-serve-'))
  pastas.push(pasta)
  return pasta
}

test('a persistência SQLite migra, segura a posse e não oferece a sonda PostgreSQL ao catálogo', async () => {
  const arquivo = join(await pastaTemporaria(), 'overcore.db')
  const persistencia = await abrirPersistencia({ engine: 'sqlite', path: arquivo }, process.cwd(), { aoPerderPosse: () => {} })
  try {
    assert.equal(persistencia.motor, 'sqlite')
    assert.equal(await persistencia.store.findById('nenhuma'), null)
    assert.throws(() => tomarPosse(arquivo, { processo: 'intruso', maquina: 'outra' }), /já tem dono/)
    assert.equal(persistencia.sondaPostgres, undefined)
    const catalogo = new ExecutorCapabilityCatalog(localExecutorCapabilities({
      hasFileReplacement: true,
      hasPostgresTableProbe: persistencia.sondaPostgres !== undefined
    }))
    assert.throws(() => catalogo.select('execute-postgres-table-probe'),
      (error: unknown) => error instanceof ExecutorCapabilityUnavailableError)
  } finally {
    await persistencia.encerrar()
  }
  soltarPosse(arquivo, tomarPosse(arquivo, { processo: 'depois', maquina: 'esta' }).token)
})

test('serve com sqlite sobe, responde a /health e, ao ser desligado pelo pai, solta a posse e o descritor', async () => {
  const pasta = await pastaTemporaria()
  const arquivo = join(pasta, 'overcore.db')
  const modulo = pathToFileURL(join(process.cwd(), '.test-dist', 'src', 'infrastructure', 'runtime', 'serve.js')).href
  const codigo = `const { serve } = await import(${JSON.stringify(modulo)}); await serve(process.argv[1])`
  const filho = spawn(process.execPath, ['--input-type=module', '-e', codigo, process.cwd()], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      LOCALAPPDATA: pasta,
      OVERCORE_DATABASE_ENGINE: 'sqlite',
      OVERCORE_SQLITE_PATH: arquivo,
      OVERCORE_PORT: '0',
      OVERCORE_LOCAL_TOKEN: 'token-local-de-teste',
      OVERCORE_AUTHORITY_PROVIDER_TOKEN: 'token-autoridade-teste',
      OVERCORE_AUTHORITY_PROVIDER_URL: 'http://127.0.0.1:9',
      OVERCORE_DISCOVERY_MODE: 'baseline'
    }
  })
  let erro = ''
  filho.stderr!.on('data', (parte: Buffer) => { erro += parte.toString('utf8') })
  const saida = new Promise<number | null>((resolve) => filho.once('exit', (codigo) => resolve(codigo)))
  try {
    const endereco = await new Promise<string>((resolve, reject) => {
      let texto = ''
      filho.stdout!.on('data', (parte: Buffer) => {
        texto += parte.toString('utf8')
        const achado = /Overcore ativo em (http:\/\/127\.0\.0\.1:\d+)/.exec(texto)
        if (achado?.[1]) resolve(achado[1])
      })
      void saida.then((codigo) => reject(new Error(`serve saiu com ${codigo} antes de subir: ${erro}`)))
      setTimeout(() => reject(new Error(`serve não subiu em 20 s: ${erro}`)), 20_000).unref()
    })
    const resposta = await fetch(`${endereco}/health`)
    assert.equal(resposta.status, 200)
    assert.deepEqual(await resposta.json(), { status: 'ok', service: 'overcore-task-manager', version: 1 })
    assert.throws(() => tomarPosse(arquivo, { processo: 'intruso', maquina: 'outra' }), /já tem dono/)
    assert.ok(existsSync(join(pasta, 'Overcore', 'runtime.json')))
  } finally {
    if (filho.connected) filho.disconnect()
  }
  assert.equal(await saida, 0, erro)
  assert.equal(existsSync(join(pasta, 'Overcore', 'runtime.json')), false)
  soltarPosse(arquivo, tomarPosse(arquivo, { processo: 'depois', maquina: 'esta' }).token)
})
