// CONTRATO OVERCORE ↔ OMNI (bloco E da F4, decisão A do E3). Este teste faz o papel do supervisor do Omni
// contra o processo de verdade, no molde do contrato-omni do Oráculo:
//
//   1. sobe `servir --porta 0` com o stdin em pipe e lê a linha {"ok":true,"porta":n};
//   2. GET /v1/saude: 401 sem token, 200 com token; nenhuma rota fica aberta;
//   3. fecha o stdin e espera o código 0, com a posse do banco solta e nenhum token na saída.
//
// Se este teste mudar, o contrato mudou: avise omni-f9 antes do commit.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

import { instalar, verificar } from '../src/executor/modos.js'
import { donoVivo, tomarPosse } from '../src/infrastructure/database/sqlite/posse.js'

const CLI = join(process.cwd(), '.test-dist', 'src', 'executor', 'overcore-executor.js')
const VERSAO = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version

const pastas: string[] = []
after(() => { for (const pasta of pastas) rmSync(pasta, { recursive: true, force: true }) })

/** Uma casa numa pasta temporária, com os segredos que o supervisor injetaria no env. */
function casa() {
  const pasta = mkdtempSync(join(tmpdir(), 'overcore-contrato-'))
  pastas.push(pasta)
  const segredos = { local: randomBytes(32).toString('base64url'), autoridade: randomBytes(32).toString('base64url') }
  const env: Record<string, string> = {
    OMNI_CASA_BANCO: join(pasta, 'casa'),
    LOCALAPPDATA: join(pasta, 'local'),
    OVERCORE_LOCAL_TOKEN: segredos.local,
    OVERCORE_AUTHORITY_PROVIDER_TOKEN: segredos.autoridade,
    OVERCORE_AUTHORITY_PROVIDER_URL: 'http://127.0.0.1:9',
    OVERCORE_DISCOVERY_MODE: 'baseline'
  }
  return { pasta, env, segredos, arquivo: join(pasta, 'casa', 'overcore.db') }
}

const ambiente = (env: Record<string, string>): NodeJS.ProcessEnv => {
  const limpo: NodeJS.ProcessEnv = { ...process.env, ...env }
  // O que o processo do teste tiver de Overcore não pode vazar para o filho.
  for (const nome of ['OVERCORE_DATABASE_ENGINE', 'OVERCORE_DATABASE_URL', 'OVERCORE_SQLITE_PATH', 'OVERCORE_PORT']) delete limpo[nome]
  return limpo
}

function subir(args: string[], env: Record<string, string>) {
  const filho = spawn(process.execPath, [CLI, ...args], { env: ambiente(env), stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
  let saida = ''
  let erro = ''
  filho.stdout.setEncoding('utf8').on('data', (d: string) => { saida += d })
  filho.stderr.setEncoding('utf8').on('data', (d: string) => { erro += d })
  const fim = new Promise<number | null>((resolver) => filho.on('close', (codigo) => resolver(codigo)))
  const primeira = new Promise<Record<string, unknown>>((resolver, rejeitar) => {
    const prazo = setTimeout(() => rejeitar(new Error(`sem primeira linha em 20 s; stderr: ${erro}`)), 20_000)
    const olhar = () => {
      if (!saida.includes('\n')) return false
      clearTimeout(prazo)
      resolver(JSON.parse(saida.split('\n')[0] ?? '') as Record<string, unknown>)
      return true
    }
    filho.stdout.on('data', olhar)
    void fim.then(() => { clearTimeout(prazo); if (!olhar()) rejeitar(new Error(`saiu sem linha; stderr: ${erro}`)) })
  })
  return { filho, primeira, fim, saida: () => saida, erro: () => erro }
}

async function pedir(porta: number, caminho: string, token?: string) {
  const resposta = await fetch(`http://127.0.0.1:${porta}${caminho}`, token ? { headers: { authorization: `Bearer ${token}` } } : {})
  return { status: resposta.status, corpo: await resposta.json() as Record<string, unknown> }
}

function rodar(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: ambiente(env), encoding: 'utf8', input: '' })
  const linhas = r.stdout.split('\n').filter(Boolean)
  assert.equal(linhas.length, 1, `uma linha de JSON no stdout; veio: ${r.stdout} / stderr: ${r.stderr}`)
  return { codigo: r.status, json: JSON.parse(linhas[0] ?? '') as Record<string, unknown>, saida: r.stdout, erro: r.stderr }
}

test('contrato Overcore↔Omni: subir com --porta 0, saúde 401/200, nenhuma rota aberta e parada pelo stdin com código 0', async () => {
  const c = casa()
  instalar({ env: c.env })
  const s = subir(['servir', '--porta', '0'], c.env)
  try {
    // 1. a linha única do stdout: o supervisor só fala com o Overcore depois dela
    const linha = await s.primeira
    assert.deepEqual(Object.keys(linha), ['ok', 'porta'])
    assert.equal(linha.ok, true)
    const porta = linha.porta as number
    assert.ok(Number.isInteger(porta) && porta > 0)

    // 2. a saúde exige token; o /health do serve legado também fecha
    assert.equal((await pedir(porta, '/v1/saude')).status, 401)
    assert.equal((await pedir(porta, '/v1/saude', 'token-errado-com-mais-de-16')).status, 401)
    assert.equal((await pedir(porta, '/health')).status, 401)
    const saude = await pedir(porta, '/v1/saude', c.segredos.local)
    assert.equal(saude.status, 200)
    assert.equal(saude.corpo.agente, 'overcore')
    assert.equal(saude.corpo.versao, VERSAO)
    assert.match(String(saude.corpo.versao), /^\d+\.\d+\.\d+$/)
    assert.ok(!Number.isNaN(Date.parse(String(saude.corpo.iniciado_em))), 'iniciado_em em ISO')
    assert.equal(saude.corpo.motor, 'sqlite')

    // o processo segura a posse do banco da casa, e o verificar o enxerga de pé e fechado
    assert.throws(() => tomarPosse(c.arquivo, { processo: 'intruso', maquina: 'outra' }), /já tem dono/)
    const vista = await verificar({ env: c.env, porta })
    assert.deepEqual(vista.verificacoes.find((v) => v.nome === 'API'), {
      nome: 'API', ok: true, porta, status: 401, leitura: 'de pé e fechada sem token'
    })
    assert.equal(vista.ok, true)

    // 3. o supervisor fecha o stdin: parada graciosa, código 0, posse solta
    s.filho.stdin.end()
    assert.equal(await s.fim, 0, `stderr: ${s.erro()}`)
    assert.equal(s.saida(), `${JSON.stringify(linha)}\n`, 'o stdout tem só a linha da porta')
    for (const segredo of Object.values(c.segredos)) {
      assert.equal(s.saida().includes(segredo) || s.erro().includes(segredo), false, 'token vazou na saída')
    }
    assert.equal(donoVivo(c.arquivo), undefined, 'a posse foi solta')
  } finally {
    if (s.filho.exitCode === null) s.filho.kill()
  }
})

// O painel na ilha: o main recebe { agente, metodo, rota, corpo } pelo agente:api, confere a rota contra
// interface.rotas do manifesto, põe o token e chama o servir. Aqui o `chamar` faz esse papel, e o card e o
// preload rodam como a ilha os carrega (CommonJS).
test('contrato Overcore↔Omni: o card e o preload pelo agente:api, contra o servir de verdade', async () => {
  const c = casa()
  instalar({ env: c.env })
  const s = subir(['servir', '--porta', '0'], c.env)
  try {
    const porta = (await s.primeira).porta as number
    const manifesto = JSON.parse(readFileSync(join(process.cwd(), 'executor', 'agente.json'), 'utf8')) as {
      interface: { preload: string; rotas: Array<{ metodo: string; padrao: string }> }
    }
    type Pedido = { agente: string; metodo: string; rota: string }
    const chamadas: string[] = []
    const chamar = async ({ agente, metodo, rota }: Pedido) => {
      if (agente !== 'overcore' || !manifesto.interface.rotas.some((r) => r.metodo === metodo && new RegExp(r.padrao).test(rota))) {
        return { status: 0, corpo: { ok: false, erro: 'rota fora do manifesto' } }
      }
      try {
        chamadas.push(rota)
        return await pedir(porta, rota, c.segredos.local)
      } catch {
        return { status: 0, corpo: { ok: false, erro: 'API fora do ar' } }
      }
    }
    const carregar = <T>(arquivo: string, requerer: (m: string) => unknown) => {
      const modulo = { exports: {} as T }
      new Function('module', 'exports', 'require', readFileSync(join(process.cwd(), arquivo), 'utf8'))(modulo, modulo.exports, requerer)
      return modulo.exports
    }
    const semRequire = (m: string) => { throw new Error(`sem require: ${m}`) }

    const card = carregar<{ resumo: (c: typeof chamar) => Promise<Record<string, unknown>> }>('interface/overcore.js', semRequire)
    const r = await card.resumo(chamar)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.agente, 'overcore')
    assert.equal(r.versao, VERSAO)
    assert.equal(r.motor, 'sqlite')
    assert.ok(!Number.isNaN(Date.parse(String(r.iniciadoEm))))

    let overcore: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    carregar('interface/overcore-preload.js', () => ({
      contextBridge: { exposeInMainWorld: (_nome: string, api: typeof overcore) => { overcore = api } },
      ipcRenderer: { invoke: (_canal: string, pedido: Pedido) => chamar(pedido) }
    }))
    const capacidades = await overcore.capacidades?.() as { capabilities: unknown[] }
    assert.ok(Array.isArray(capacidades.capabilities))
    const evidencias = await overcore.evidencias?.() as { status: string }
    assert.equal(typeof evidencias.status, 'string')
    assert.equal(await overcore.tarefa?.('task-que-nao-existe'), null)
    assert.deepEqual(chamadas, ['/v1/saude', '/v1/capabilities', '/v1/validation-evidence', '/v1/tasks/task-que-nao-existe'])

    // o servir parado: o card cai em pé com o motivo do main
    s.filho.stdin.end()
    assert.equal(await s.fim, 0, `stderr: ${s.erro()}`)
    assert.deepEqual(await card.resumo(chamar), { ok: false, erro: 'API fora do ar' })
  } finally {
    if (s.filho.exitCode === null) s.filho.kill()
  }
})

test('servir recusa banco com migração pendente e não toca nele', () => {
  const c = casa()
  mkdirSync(join(c.pasta, 'casa'), { recursive: true })
  new DatabaseSync(c.arquivo).close() // existe, mas nunca foi migrado
  const antes = readFileSync(c.arquivo)
  const r = rodar(['servir', '--porta', '0'], c.env)
  assert.equal(r.codigo, 1)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.recusa, true)
  assert.match(String(r.json.erro), /pendente/)
  assert.match(String(r.json.erro), /atualizar/)
  assert.deepEqual(readFileSync(c.arquivo), antes)
})

test('servir recusa casa não instalada, uso errado sai com 2 e falha de configuração sai com 1', () => {
  const c = casa()
  const semCasa = rodar(['servir', '--porta', '0'], c.env)
  assert.equal(semCasa.codigo, 1)
  assert.equal(semCasa.json.recusa, true)
  assert.match(String(semCasa.json.erro), /instalar/)

  for (const args of [['servir'], ['servir', '--porta', '70000'], ['servir', '--porta', 'abc'], ['servir', '--porta', '0', 'sobra']]) {
    const r = rodar(args, c.env)
    assert.equal(r.codigo, 2, `${args.join(' ')}: ${r.saida}`)
    assert.match(String(r.json.uso), /^uso: overcore-executor/)
  }

  instalar({ env: c.env })
  const { OVERCORE_LOCAL_TOKEN: _token, ...semToken } = c.env
  const r = rodar(['servir', '--porta', '0'], semToken)
  assert.equal(r.codigo, 1)
  assert.deepEqual(Object.keys(r.json), ['ok', 'erro'])
  assert.equal(r.json.ok, false)
  assert.match(String(r.json.erro), /OVERCORE_LOCAL_TOKEN/)
  assert.equal(donoVivo(c.arquivo), undefined, 'subida que falha não deixa a posse presa')
  for (const segredo of Object.values(c.segredos)) assert.equal(r.saida.includes(segredo) || r.erro.includes(segredo), false)
})
