import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { comBanco } from '../src/infrastructure/database/sqlite/banco.js'
import { aplicarMigracoes } from '../src/infrastructure/database/sqlite/migracoes.js'
import { renovarPosse, soltarPosse, tomarPosse } from '../src/infrastructure/database/sqlite/posse.js'

const MODULO_POSSE = new URL('../src/infrastructure/database/sqlite/posse.js', import.meta.url).href

const pastas: string[] = []
const filhos: ChildProcessWithoutNullStreams[] = []
after(async () => {
  for (const filho of filhos) filho.kill()
  await Promise.all(pastas.map((pasta) => rm(pasta, { recursive: true, force: true })))
})

async function bancoMigrado(): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), 'overcore-posse-'))
  pastas.push(pasta)
  const arquivo = join(pasta, 'overcore.db')
  aplicarMigracoes(arquivo, join(process.cwd(), 'migrations-sqlite'))
  return arquivo
}

const CODIGO_FILHO = `
const [modulo, arquivo, ttl] = process.argv.slice(1)
const { tomarPosse, soltarPosse } = await import(modulo)
const posse = tomarPosse(arquivo, { processo: String(process.pid), maquina: 'filho', ttlMs: Number(ttl) })
process.stdout.write('TOMADA\\n')
process.stdin.on('data', (dado) => {
  if (!String(dado).includes('soltar')) return
  soltarPosse(arquivo, posse.token)
  process.stdout.write('SOLTA\\n')
  process.exit(0)
})
`

/** Sobe um processo real que toma a posse e a segura até receber "soltar" ou morrer. */
async function filhoDono(arquivo: string, ttlMs: number): Promise<ChildProcessWithoutNullStreams> {
  const filho = spawn(process.execPath, ['--input-type=module', '-e', CODIGO_FILHO, MODULO_POSSE, arquivo, String(ttlMs)])
  filhos.push(filho)
  await linha(filho, 'TOMADA')
  return filho
}

function linha(filho: ChildProcessWithoutNullStreams, esperada: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let saida = ''
    let erro = ''
    const prazo = setTimeout(() => reject(new Error(`Filho não disse ${esperada}: ${saida} ${erro}`)), 10_000)
    filho.stderr.on('data', (dado: Buffer) => { erro += String(dado) })
    filho.stdout.on('data', (dado: Buffer) => {
      saida += String(dado)
      if (saida.includes(esperada)) { clearTimeout(prazo); resolve() }
    })
    filho.once('exit', (codigo) => { if (!saida.includes(esperada)) { clearTimeout(prazo); reject(new Error(`Filho saiu (${codigo}): ${erro}`)) } })
  })
}

function morto(filho: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => { if (filho.exitCode !== null || filho.signalCode !== null) resolve(); else filho.once('exit', () => resolve()) })
}

test('outro processo é recusado enquanto a posse vale e entra na hora em que ela é solta', async () => {
  const arquivo = await bancoMigrado()
  const filho = await filhoDono(arquivo, 60_000)
  assert.throws(
    () => tomarPosse(arquivo, { processo: 'pai', maquina: 'teste' }),
    (error: unknown) => error instanceof Error && /já tem dono/.test(error.message) && error.message.includes(`processo ${filho.pid}`)
  )
  filho.stdin.write('soltar\n')
  await linha(filho, 'SOLTA')
  const posse = tomarPosse(arquivo, { processo: 'pai', maquina: 'teste' })
  assert.equal(comBanco(arquivo, (db) => db.prepare('SELECT token FROM _dono').get()?.token), posse.token)
})

test('processo que morre sem soltar perde a posse quando o prazo vence', async () => {
  const arquivo = await bancoMigrado()
  const filho = await filhoDono(arquivo, 60_000)
  filho.kill('SIGKILL')
  await morto(filho)
  assert.throws(() => tomarPosse(arquivo, { processo: 'pai', maquina: 'teste' }), /já tem dono/)
  // O prazo vence no relógio injetado: sob carga, um TTL curto de parede venceria antes da primeira asserção.
  const depoisDoPrazo = () => new Date(Date.now() + 61_000)
  const posse = tomarPosse(arquivo, { processo: 'pai', maquina: 'teste', agora: depoisDoPrazo })
  assert.match(posse.token, /^[0-9a-f-]{36}$/)
})

test('renovar estende o prazo e falha se a posse já é de outro', async () => {
  const arquivo = await bancoMigrado()
  const t0 = new Date('2026-11-05T12:00:00.000Z')
  const posse = tomarPosse(arquivo, { processo: 'a', maquina: 'm', ttlMs: 30_000, agora: () => t0 })
  assert.equal(posse.ate, '2026-11-05T12:00:30.000Z')
  const t1 = new Date('2026-11-05T12:00:10.000Z')
  assert.equal(renovarPosse(arquivo, posse.token, { ttlMs: 30_000, agora: () => t1 }).ate, '2026-11-05T12:00:40.000Z')
  const t2 = new Date('2026-11-05T12:01:00.000Z')
  const outra = tomarPosse(arquivo, { processo: 'b', maquina: 'm', ttlMs: 30_000, agora: () => t2 })
  assert.notEqual(outra.token, posse.token)
  assert.throws(() => renovarPosse(arquivo, posse.token, { agora: () => t2 }), /posse do banco foi perdida/i)
})

test('soltar com token alheio não derruba o dono atual', async () => {
  const arquivo = await bancoMigrado()
  const posse = tomarPosse(arquivo, { processo: 'a', maquina: 'm' })
  soltarPosse(arquivo, 'token-que-nao-e-dele')
  assert.throws(() => tomarPosse(arquivo, { processo: 'b', maquina: 'm' }), /já tem dono/)
  soltarPosse(arquivo, posse.token)
  soltarPosse(arquivo, posse.token)
  tomarPosse(arquivo, { processo: 'b', maquina: 'm' })
})
