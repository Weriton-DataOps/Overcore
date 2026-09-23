import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Local supervisor for this pair only; never kills another runtime/session.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const omni = process.argv[2]
if (!omni || !isAbsolute(omni)) throw new Error('Informe a pasta canônica do Omni como argumento absoluto.')
if (!process.env.OVERCORE_DATABASE_URL || !process.env.LOCALAPPDATA) throw new Error('Conexão operacional/LOCALAPPDATA ausentes.')
const directory = join(process.env.LOCALAPPDATA, 'Overcore')
await mkdir(directory, { recursive: true })
const lockPath = join(directory, 'local-supervisor.json')
let lock
try { lock = await open(lockPath, 'wx', 0o600) }
catch (error) {
  if (error.code !== 'EEXIST') throw error
  const prior = JSON.parse(await readFile(lockPath, 'utf8'))
  let active = true
  try { process.kill(prior.pid, 0) } catch (failure) { if (failure.code === 'ESRCH') active = false }
  if (active) throw new Error('Já há supervisor local; preserve a instância existente.')
  await rm(lockPath)
  lock = await open(lockPath, 'wx', 0o600)
}
await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.close()
const children = []
let stopping = false
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  await Promise.all(children.map(child => new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit()
    const timer = setTimeout(resolveExit, 5000)
    child.once('exit', () => { clearTimeout(timer); resolveExit() })
    child.kill()
  })))
  await rm(lockPath, { force: true })
  process.exitCode = code
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
function launch(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.stderr.resume()
  return child
}
async function firstLine(child) {
  return new Promise((resolveLine, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('Serviço não anunciou prontidão.')), 20_000)
    child.once('error', () => { clearTimeout(timer); reject(new Error('Não foi possível iniciar o processo local.')) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Serviço encerrou durante início: ${code}.`)) })
    child.stdout.setEncoding('utf8')
    const receive = chunk => {
      buffer += chunk
      if (buffer.includes('\n')) {
        clearTimeout(timer); child.stdout.off('data', receive); child.stdout.resume()
        resolveLine(buffer.split('\n')[0])
      }
    }
    child.stdout.on('data', receive)
  })
}
try {
  const privatePath = join(directory, 'client-private.json')
  let localToken = process.env.OVERCORE_LOCAL_TOKEN
  if (!localToken) {
    try { localToken = JSON.parse(await readFile(privatePath, 'utf8')).localToken } catch {}
  }
  if (typeof localToken !== 'string' || localToken.length < 16) localToken = randomBytes(32).toString('hex')
  const authorityToken = randomBytes(32).toString('hex')
  const authority = launch([join(omni, 'adaptadores', 'overcore-authority-http.mjs')], omni, {
    ...process.env, OMNI_AUTHORITY_PROVIDER_TOKEN: authorityToken, OMNI_AUTHORITY_PROVIDER_PORT: '0'
  })
  const ready = JSON.parse(await firstLine(authority))
  const endpoint = new URL(ready.url)
  if (ready.status !== 'ready' || endpoint.hostname !== '127.0.0.1') throw new Error('Autoridade não anunciou endpoint local válido.')
  const runtime = launch([join(root, 'dist', 'main.js'), 'serve'], root, {
    ...process.env, OVERCORE_LOCAL_TOKEN: localToken, OVERCORE_HOST: '127.0.0.1', OVERCORE_PORT: '0',
    OVERCORE_AUTHORITY_PROVIDER_URL: endpoint.href, OVERCORE_AUTHORITY_PROVIDER_TOKEN: authorityToken,
    OVERCORE_DISCOVERY_MODE: process.env.OVERCORE_DISCOVERY_MODE || 'advisor'
  })
  const announcement = await firstLine(runtime)
  if (!announcement.startsWith('Overcore ativo em http://127.0.0.1:')) throw new Error('Runtime não confirmou prontidão.')
  await writeFile(privatePath, JSON.stringify({ schemaVersion: 1, localToken }) + '\n', { mode: 0o600 })
  for (const child of children) child.once('exit', () => { if (!stopping) void stop(1) })
  process.stdout.write(JSON.stringify({ status: 'ready', pid: process.pid, discovery: process.env.OVERCORE_DISCOVERY_MODE || 'advisor' }) + '\n')
} catch (error) {
  process.stderr.write(`Inicialização local falhou: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
  await stop(1)
}
