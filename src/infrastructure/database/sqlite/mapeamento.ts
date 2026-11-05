/**
 * Traduções entre o domínio e o texto do SQLite (ADR-023 D5 e D6).
 * Tempo vira o ISO de 24 caracteres, que ordena como texto; JSON vira texto.
 */

const SQLITE_CONSTRAINT = 19
const UNICIDADE = /^UNIQUE constraint failed: (.+)$/

export interface Unicidade { tabela: string; colunas: string[] }

/** Normaliza qualquer instante aceito pelo domínio para o formato gravado e comparado no banco. */
export function instante(valor: string | Date): string {
  const data = valor instanceof Date ? valor : new Date(valor)
  if (Number.isNaN(data.getTime())) throw new Error(`Instante inválido: ${String(valor)}`)
  return data.toISOString()
}

export function lerJson<T extends object = Record<string, unknown>>(texto: string): T {
  const valor: unknown = JSON.parse(texto)
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    throw new Error('Documento JSON do banco não é um objeto.')
  }
  return valor as T
}

/**
 * Lê a colisão de chave única do erro do SQLite, no lugar do `constraint` do PostgreSQL.
 * Devolve null para qualquer outro erro, que segue intacto para quem chamou.
 */
export function unicidade(error: unknown): Unicidade | null {
  if (!(error instanceof Error)) return null
  const errcode = (error as { errcode?: unknown }).errcode
  if (typeof errcode !== 'number' || (errcode & 0xff) !== SQLITE_CONSTRAINT) return null
  const partes = UNICIDADE.exec(error.message)
  if (!partes?.[1]) return null
  const colunas = partes[1].split(', ').map((qualificada) => qualificada.split('.'))
  const tabela = colunas[0]?.[0]
  if (!tabela || colunas.some((coluna) => coluna.length !== 2 || coluna[0] !== tabela)) return null
  return { tabela, colunas: colunas.map((coluna) => String(coluna[1])) }
}
