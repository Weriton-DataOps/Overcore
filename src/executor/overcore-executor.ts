#!/usr/bin/env node
// Sub-executor do Overcore na casa única (ADR-024). Quem chama é o executor do Omni, pelo comando declarado
// em executor/agente.json. Saída: uma linha de JSON no stdout. Código: 0 ok, 1 erro ou verificação com
// falha, 2 uso errado.
//
//   instalar
//   importar   <pasta-do-pacote>
//   exportar   [--destino <pasta>]
//   atualizar
//   verificar  [--pacote <pasta>] [--porta <n>]
//   servir     --porta <n>     (ambiente: OVERCORE_LOCAL_TOKEN, OVERCORE_AUTHORITY_PROVIDER_URL e _TOKEN)
//
// O servir é o único modo longo. A linha {"ok":true,"porta":n} sai só com a porta ouvindo e é a única do
// stdout; o log vai para o stderr. Para com graça quando o stdin fecha (e, fora do Windows, com SIGTERM ou
// SIGINT; com canal IPC, também no disconnect). Falha na subida: a linha {"ok":false,...} e código 1.
// Não se reinicia: isso é do supervisor. Nenhum token é escrito em lugar nenhum.
import { parseArgs } from 'node:util'

import { atualizar, ErroExecutor, exportar, importar, instalar, servir, verificar } from './modos.js'

const USO = 'uso: overcore-executor <instalar|importar|exportar|atualizar|verificar|servir> [opções]'
const log = (texto: string) => { process.stderr.write(`[overcore servir ${new Date().toISOString()}] ${texto}\n`) }

class ErroDeUso extends Error {}

function porta(valor: string | undefined, modo: string): number | undefined {
  if (valor === undefined) return undefined
  if (!/^\d{1,5}$/.test(valor) || Number(valor) > 65_535) throw new ErroDeUso(`${modo}: --porta é um número de 0 a 65535`)
  return Number(valor)
}

type Parar = () => Promise<void>

let perdeuPosse: ((error: Error) => void) | undefined

async function rodar(argv: string[]): Promise<{ ok: boolean; parar?: Parar }> {
  let analise
  try {
    analise = parseArgs({
      args: argv,
      options: { porta: { type: 'string' }, pacote: { type: 'string' }, destino: { type: 'string' } },
      allowPositionals: true,
      strict: true
    })
  } catch (error) {
    throw new ErroDeUso(error instanceof Error ? error.message : String(error))
  }
  const { values, positionals: [modo, ...resto] } = analise
  const posicionais = (n: number) => { if (resto.length !== n) throw new ErroDeUso(`${modo}: ${n ? 'diga a pasta do pacote' : 'argumento a mais'}`) }
  switch (modo) {
    case 'instalar': posicionais(0); return instalar()
    case 'atualizar': posicionais(0); return atualizar()
    case 'exportar': posicionais(0); return exportar({ destino: values.destino })
    case 'importar': posicionais(1); return importar({ pacote: resto[0] })
    case 'verificar': {
      posicionais(0)
      return verificar({ porta: porta(values.porta, modo), pacote: values.pacote })
    }
    case 'servir': {
      posicionais(0)
      const p = porta(values.porta, modo)
      if (p === undefined) throw new ErroDeUso('servir: diga a --porta')
      return servir({ porta: p, log, aoPerderPosse: (error) => perdeuPosse?.(error) })
    }
    default:
      throw new ErroDeUso(modo ? `modo desconhecido: ${modo}` : 'falta o modo')
  }
}

// O servir fica de pé até o stdin fechar; nada de process.exit: a saída é o laço esvaziar.
function esperarParada(parar: Parar): void {
  const sinais: NodeJS.Signals[] = process.platform === 'win32' ? [] : ['SIGTERM', 'SIGINT']
  let parando = false
  const pare = (motivo: string, codigo: number) => {
    if (parando) return
    parando = true
    log(`parando: ${motivo}`)
    for (const s of sinais) process.removeListener(s, aoSinal)
    process.stdin.pause()
    process.stdin.destroy()
    if (process.connected) process.disconnect()
    parar().then(
      () => { log('parado'); process.exitCode = codigo },
      (error: unknown) => { log(`erro ao parar: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
    )
  }
  const aoSinal = (s: NodeJS.Signals) => pare(s, 0)
  perdeuPosse = (error) => pare(error.message, 1)
  process.stdin.on('end', () => pare('stdin fechado', 0))
  process.stdin.on('error', () => pare('stdin com erro', 0))
  process.stdin.resume() // o que vier no stdin é descartado; o que importa é o fim
  for (const s of sinais) process.on(s, aoSinal)
  if (process.connected) process.once('disconnect', () => pare('canal IPC fechado', 0))
}

try {
  const { parar, ...resultado } = await rodar(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(resultado)}\n`)
  process.exitCode = resultado.ok ? 0 : 1
  if (parar) esperarParada(parar)
} catch (error) {
  const uso = error instanceof ErroDeUso
  process.stdout.write(`${JSON.stringify({
    ok: false,
    erro: error instanceof Error ? error.message : String(error),
    ...(uso ? { uso: USO } : {}),
    ...(error instanceof ErroExecutor ? { recusa: true } : {})
  })}\n`)
  process.exitCode = uso ? 2 : 1
}
