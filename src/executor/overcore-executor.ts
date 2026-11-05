#!/usr/bin/env node
// Sub-executor do Overcore na casa única (ADR-024). Quem chama é o executor do Omni, pelo comando declarado
// em executor/agente.json. Saída: uma linha de JSON no stdout. Código: 0 ok, 1 erro ou verificação com
// falha, 2 uso errado.
//
//   instalar
//   atualizar
//   verificar  [--porta <n>]
import { parseArgs } from 'node:util'

import { atualizar, ErroExecutor, instalar, verificar } from './modos.js'

const USO = 'uso: overcore-executor <instalar|atualizar|verificar> [opções]'

class ErroDeUso extends Error {}

function porta(valor: string | undefined, modo: string): number | undefined {
  if (valor === undefined) return undefined
  if (!/^\d{1,5}$/.test(valor) || Number(valor) > 65_535) throw new ErroDeUso(`${modo}: --porta é um número de 0 a 65535`)
  return Number(valor)
}

async function rodar(argv: string[]): Promise<{ ok: boolean }> {
  let analise
  try {
    analise = parseArgs({ args: argv, options: { porta: { type: 'string' } }, allowPositionals: true, strict: true })
  } catch (error) {
    throw new ErroDeUso(error instanceof Error ? error.message : String(error))
  }
  const { values, positionals: [modo, ...resto] } = analise
  if (modo && resto.length) throw new ErroDeUso(`${modo}: argumento a mais`)
  switch (modo) {
    case 'instalar': return instalar()
    case 'atualizar': return atualizar()
    case 'verificar': {
      const p = porta(values.porta, modo)
      return verificar(p === undefined ? {} : { porta: p })
    }
    default:
      throw new ErroDeUso(modo ? `modo desconhecido: ${modo}` : 'falta o modo')
  }
}

try {
  const resultado = await rodar(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(resultado)}\n`)
  process.exitCode = resultado.ok ? 0 : 1
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
