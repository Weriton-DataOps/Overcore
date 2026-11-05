import { randomUUID } from 'node:crypto'
import { comBanco, transacao } from './banco.js'

/**
 * Posse do arquivo por um único processo (ADR-023 D2). A cerca por tarefa da D3
 * só vale dentro de um processo; a posse garante que só existe um.
 * O dono renova no ritmo do worker; se cair sem soltar, a posse vence sozinha.
 */

export const TTL_POSSE_MS = 30_000

export interface Posse { token: string; ate: string }

interface Relogio { ttlMs?: number; agora?: () => Date }

interface LinhaDono { processo: string; maquina: string; token: string; ate: string }

function prazo({ ttlMs = TTL_POSSE_MS, agora = () => new Date() }: Relogio): { agora: Date; ate: string } {
  const instante = agora()
  return { agora: instante, ate: new Date(instante.getTime() + ttlMs).toISOString() }
}

/** Toma a posse se o arquivo estiver sem dono ou com a posse vencida; senão, falha. */
export function tomarPosse(arquivo: string, dono: { processo: string; maquina: string } & Relogio): Posse {
  const { agora, ate } = prazo(dono)
  const token = randomUUID()
  comBanco(arquivo, (db) => transacao(db, () => {
    const atual = db.prepare('SELECT processo, maquina, token, ate FROM _dono WHERE id = 1').get() as LinhaDono | undefined
    if (atual && Date.parse(atual.ate) > agora.getTime()) {
      throw new Error(`O banco já tem dono: processo ${atual.processo} em ${atual.maquina}, com posse até ${atual.ate}.`)
    }
    db.prepare(`INSERT INTO _dono (id, processo, maquina, token, ate) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET processo = excluded.processo, maquina = excluded.maquina,
        token = excluded.token, ate = excluded.ate`).run(dono.processo, dono.maquina, token, ate)
  }))
  return { token, ate }
}

/** Estende o prazo. Falha se outro processo assumiu: quem perdeu a posse precisa parar de escrever. */
export function renovarPosse(arquivo: string, token: string, relogio: Relogio = {}): Posse {
  const { ate } = prazo(relogio)
  const mudou = comBanco(arquivo, (db) => transacao(db, () =>
    Number(db.prepare('UPDATE _dono SET ate = ? WHERE id = 1 AND token = ?').run(ate, token).changes)))
  if (mudou !== 1) throw new Error('A posse do banco foi perdida para outro processo; este processo precisa parar de escrever.')
  return { token, ate }
}

/** Solta a posse se ainda for deste token. Soltar duas vezes, ou depois de perder, não faz nada. */
export function soltarPosse(arquivo: string, token: string): void {
  comBanco(arquivo, (db) => transacao(db, () => { db.prepare('DELETE FROM _dono WHERE id = 1 AND token = ?').run(token) }))
}
