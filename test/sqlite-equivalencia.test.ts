import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// ADR-023 D7: cada migração PostgreSQL precisa de uma equivalente SQLite declarada.
// Migração nova em migrations/ sem linha em EQUIVALENCIA.md quebra npm test, e os motores não se afastam calados.

const raiz = process.cwd()

function linhasDeEquivalencia(): Array<{ postgres: string; sqlite: string[] }> {
  const texto = readFileSync(join(raiz, 'migrations-sqlite', 'EQUIVALENCIA.md'), 'utf8')
  return texto.split(/\r?\n/)
    .filter((linha) => /^\|\s*`\d{3}_[^`]+\.sql`/.test(linha))
    .map((linha) => {
      const [postgres = '', sqlite = ''] = linha.split('|').slice(1).map((celula) => celula.trim())
      return {
        postgres: postgres.replace(/`/g, ''),
        sqlite: [...sqlite.matchAll(/`([^`]+\.sql)`/g)].map((achado) => achado[1] ?? '')
      }
    })
}

test('toda migração PostgreSQL tem equivalente SQLite declarada, e a tabela não cita migração que não existe', () => {
  const postgres = readdirSync(join(raiz, 'migrations')).filter((nome) => nome.endsWith('.sql')).sort()
  const linhas = linhasDeEquivalencia()
  const declaradas = linhas.map((linha) => linha.postgres)
  assert.deepEqual([...declaradas].sort(), postgres, 'EQUIVALENCIA.md precisa de exatamente uma linha por migração de migrations/')
  for (const linha of linhas) {
    assert.ok(linha.sqlite.length > 0, `${linha.postgres} não aponta para nenhuma migração SQLite`)
    for (const destino of linha.sqlite) {
      assert.ok(existsSync(join(raiz, 'migrations-sqlite', destino)), `${linha.postgres} aponta para ${destino}, que não existe em migrations-sqlite/`)
    }
  }
})
