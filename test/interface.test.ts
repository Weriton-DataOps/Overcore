// F4, bloco E (E4): o painel do Overcore na ilha do Omni. A ilha monta interface.modulo e carrega
// interface.preload; o renderer só fala com a API pelo IPC agente:api ({agente, metodo, rota, corpo} →
// {status, corpo}, status 0 = o main recusou), e o main só deixa passar rota declarada em interface.rotas.
// O painel é de leitura: nenhuma rota de escrita sai do manifesto.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'

const REPO = process.cwd()
const INTERFACE = join(REPO, 'interface')
const AGENTE = JSON.parse(readFileSync(join(REPO, 'executor', 'agente.json'), 'utf8')) as {
  interface: { modulo: string; preload: string; painel: string; api: string; rotas: Array<{ metodo: string; padrao: string; escopo: string }> }
}

type Pedido = { agente: string; metodo: string; rota: string; corpo: unknown }
type Volta = { status: number; corpo: unknown }
type Chamar = (pedido: Pedido) => Promise<Volta>

const ID = '[A-Za-z0-9._:-]+'
const ROTAS = [
  { metodo: 'GET', padrao: '^/v1/saude$', escopo: 'qualquer' },
  { metodo: 'GET', padrao: '^/v1/capabilities$', escopo: 'qualquer' },
  { metodo: 'GET', padrao: '^/v1/validation-evidence$', escopo: 'qualquer' },
  { metodo: 'GET', padrao: `^/v1/tasks/${ID}$`, escopo: 'qualquer' }
]

const naRota = (metodo: string, rota: string) => AGENTE.interface.rotas.some((r) => r.metodo === metodo && new RegExp(r.padrao).test(rota))

function arquivosDe(pasta: string): string[] {
  return readdirSync(pasta, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(REPO, join(e.parentPath, e.name)).split(sep).join('/'))
}

/** Carrega um arquivo da interface como a ilha carrega (CommonJS), com o require que o teste quiser. */
function carregar<T>(arquivo: string, requerer: (m: string) => unknown = (m) => { throw new Error(`${arquivo} não pode importar ${m}`) }): T {
  const modulo = { exports: {} as T }
  new Function('module', 'exports', 'require', readFileSync(join(REPO, arquivo), 'utf8'))(modulo, modulo.exports, requerer)
  return modulo.exports
}

test('agente.json declara o painel: módulo, preload e só as rotas de leitura da API', () => {
  const i = AGENTE.interface
  assert.deepEqual(Object.keys(i), ['modulo', 'preload', 'painel', 'api', 'rotas'])
  assert.equal(i.modulo, 'interface/index.html')
  assert.equal(i.preload, 'interface/overcore-preload.js')
  assert.equal(i.painel, 'Overcore')
  assert.ok(existsSync(join(REPO, i.modulo)))
  assert.ok(existsSync(join(REPO, i.preload)))
  assert.deepEqual(i.rotas, ROTAS)
  for (const rota of ['/v1/saude', '/v1/capabilities', '/v1/validation-evidence', '/v1/tasks/task-1', '/v1/tasks/a.b:c_d-e']) {
    assert.ok(naRota('GET', rota), `${rota} passa`)
  }
  for (const [metodo, rota] of [
    ['POST', '/v1/tasks/task-1/cancel'], ['GET', '/v1/tasks/task-1/cancel'], ['POST', '/v1/tasks/task-1/resume'],
    ['POST', '/v1/preflight'], ['POST', '/v1/preflight/r-1/admit'], ['POST', '/v1/work-once'], ['POST', '/v1/tasks'],
    ['GET', '/v1/tasks/'], ['GET', '/v1/tasks/a%2Fb'], ['GET', '/v1/saude?x=1'], ['GET', '/health']
  ] as const) {
    assert.equal(naRota(metodo, rota), false, `${metodo} ${rota} não passa`)
  }
})

test('a interface fala só pelo agente:api: nada de disco, rede, processo ou HTML injetado', () => {
  const codigo = arquivosDe(INTERFACE).filter((f) => f.endsWith('.js'))
  assert.deepEqual(codigo.sort(), ['interface/overcore-preload.js', 'interface/overcore.js', 'interface/painel.js'])
  for (const f of codigo) {
    const texto = readFileSync(join(REPO, f), 'utf8')
    const modulos = [...texto.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
    const permitido = f.endsWith('-preload.js') ? ['electron'] : []
    assert.deepEqual(modulos.filter((m) => m === undefined || !permitido.includes(m)), [], `${f} importa ${modulos.join(', ')}`)
    assert.equal(/\bprocess\.env\b|\bfetch\(|XMLHttpRequest|WebSocket|\beval\(|new Function/.test(texto), false, `${f} sai do canal`)
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(texto), false, `${f}: dado da API entra como texto, nunca como HTML`)
  }
  const html = readFileSync(join(REPO, AGENTE.interface.modulo), 'utf8')
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'">/)
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  assert.ok(scripts.length > 0)
  for (const [, atributos = '', corpo = ''] of scripts) {
    assert.equal(corpo.trim(), '', 'nenhum script inline')
    const src = /\bsrc="([^"]+)"/.exec(atributos)?.[1]
    assert.ok(src && existsSync(join(INTERFACE, src)), `script ${src ?? '?'} existe`)
  }
})

test('o preload expõe window.overcore e cada pedido sai numa rota do manifesto, sem token', async () => {
  const pedidos: Pedido[] = []
  let volta: Volta = { status: 200, corpo: { agente: 'overcore' } }
  let exposto: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  const electron = {
    contextBridge: { exposeInMainWorld: (nome: string, api: typeof exposto) => { assert.equal(nome, 'overcore'); exposto = api } },
    ipcRenderer: { invoke: async (canal: string, pedido: Pedido) => { assert.equal(canal, 'agente:api'); pedidos.push(pedido); return volta } }
  }
  carregar(AGENTE.interface.preload, (m) => { assert.equal(m, 'electron'); return electron })
  assert.deepEqual(Object.keys(exposto).sort(), ['capacidades', 'evidencias', 'saude', 'tarefa'])

  assert.deepEqual(await exposto.saude?.(), { agente: 'overcore' })
  await exposto.capacidades?.()
  await exposto.evidencias?.()
  await exposto.tarefa?.('task-1')
  assert.deepEqual(pedidos, [
    { agente: 'overcore', metodo: 'GET', rota: '/v1/saude', corpo: null },
    { agente: 'overcore', metodo: 'GET', rota: '/v1/capabilities', corpo: null },
    { agente: 'overcore', metodo: 'GET', rota: '/v1/validation-evidence', corpo: null },
    { agente: 'overcore', metodo: 'GET', rota: '/v1/tasks/task-1', corpo: null }
  ])
  for (const p of pedidos) assert.ok(naRota(p.metodo, p.rota), `${p.rota} está no manifesto`)

  volta = { status: 404, corpo: { error: 'not-found' } }
  assert.equal(await exposto.tarefa?.('sumiu'), null, 'tarefa que não existe é null, não erro')
  const antes = pedidos.length
  await assert.rejects(exposto.tarefa?.('a/b') ?? Promise.resolve(), /id de tarefa/)
  await assert.rejects(exposto.tarefa?.('') ?? Promise.resolve(), /id de tarefa/)
  assert.equal(pedidos.length, antes, 'id fora do formato nem chega ao main')

  volta = { status: 0, corpo: { ok: false, erro: 'rota fora do manifesto' } }
  await assert.rejects(exposto.saude?.() ?? Promise.resolve(), /rota fora do manifesto/)
  volta = { status: 401, corpo: { error: 'unauthorized' } }
  await assert.rejects(exposto.capacidades?.() ?? Promise.resolve(), /unauthorized/)
})

type Resumo = { ok: boolean; erro?: string; agente?: string; versao?: string; motor?: string; iniciadoEm?: string }
const resumo = (chamar?: Chamar) => carregar<{ resumo: (c?: Chamar) => Promise<Resumo> }>('interface/overcore.js').resumo(chamar)

test('o card do Overcore pede a saúde pelo agente:api e devolve a forma do card', async () => {
  const pedidos: Pedido[] = []
  const r = await resumo(async (p) => {
    pedidos.push(p)
    return { status: 200, corpo: { agente: 'overcore', versao: '0.1.0', motor: 'sqlite', iniciado_em: '2026-11-05T12:00:00.000Z' } }
  })
  assert.deepEqual(r, { ok: true, agente: 'overcore', versao: '0.1.0', motor: 'sqlite', iniciadoEm: '2026-11-05T12:00:00.000Z' })
  assert.deepEqual(pedidos, [{ agente: 'overcore', metodo: 'GET', rota: '/v1/saude', corpo: null }])
  assert.ok(naRota('GET', '/v1/saude'))
})

test('o card do Overcore cai em pé quando o canal recusa, a API erra ou nem há canal', async () => {
  assert.deepEqual(await resumo(async () => ({ status: 0, corpo: { ok: false, erro: 'API fora do ar' } })), { ok: false, erro: 'API fora do ar' })
  assert.deepEqual(await resumo(async () => ({ status: 401, corpo: { error: 'unauthorized' } })), { ok: false, erro: 'unauthorized' })
  assert.deepEqual(await resumo(async () => { throw new Error('canal caiu') }), { ok: false, erro: 'Overcore fora do ar' })
  assert.deepEqual(await resumo(async () => ({ status: 200, corpo: 'texto' })), { ok: false, erro: 'Overcore fora do ar' })
  assert.deepEqual(await resumo(), { ok: false, erro: 'Overcore sem canal' })
})

test('o painel resume a tarefa só com o que a tela mostra', () => {
  const { resumoDaTarefa } = carregar<{ resumoDaTarefa: (t: unknown) => Record<string, unknown> }>('interface/painel.js')
  assert.deepEqual(resumoDaTarefa({
    taskId: 'task-1', stateRevision: 3, acceptedAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T11:00:00.000Z',
    lifecycle: { state: 'running', enteredAt: '2026-11-05T10:30:00.000Z', lastTransitionId: 't-3' },
    criterionProgress: [{ status: 'met' }, { status: 'pending' }], ledger: { segredo: 'não aparece' }
  }), {
    id: 'task-1', estado: 'running', revisao: 3, aceitaEm: '2026-11-05T10:00:00.000Z',
    atualizadaEm: '2026-11-05T11:00:00.000Z', noEstadoDesde: '2026-11-05T10:30:00.000Z', criterios: 2
  })
  assert.deepEqual(resumoDaTarefa(null), null)
  assert.deepEqual(resumoDaTarefa({ taskId: 'x' }), {
    id: 'x', estado: '?', revisao: null, aceitaEm: null, atualizadaEm: null, noEstadoDesde: null, criterios: 0
  })
})
