import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadRuntimeConfig } from '../src/infrastructure/runtime/config.js'

const base = {
  LOCALAPPDATA: join(tmpdir(), 'overcore-config-test'),
  OVERCORE_LOCAL_TOKEN: 'local-token-0123456789',
  OVERCORE_AUTHORITY_PROVIDER_TOKEN: 'authority-token-0123456789',
  OVERCORE_AUTHORITY_PROVIDER_URL: 'http://127.0.0.1:9/'
}

test('sem motor declarado o padrão continua PostgreSQL e exige a URL', () => {
  assert.throws(() => loadRuntimeConfig({ ...base }), /OVERCORE_DATABASE_URL não foi definido/)
  const config = loadRuntimeConfig({ ...base, OVERCORE_DATABASE_URL: 'postgres://u@127.0.0.1:5432/overcore' })
  assert.deepEqual(config.database, { engine: 'postgres', url: 'postgres://u@127.0.0.1:5432/overcore' })
})

test('motor sqlite exige caminho absoluto explícito e dispensa a URL do PostgreSQL', () => {
  const path = join(tmpdir(), 'overcore-config-test', 'overcore.db')
  const config = loadRuntimeConfig({ ...base, OVERCORE_DATABASE_ENGINE: 'sqlite', OVERCORE_SQLITE_PATH: path })
  assert.deepEqual(config.database, { engine: 'sqlite', path })
})

test('motor sqlite sem caminho não cai em lugar nenhum por omissão', () => {
  assert.throws(() => loadRuntimeConfig({ ...base, OVERCORE_DATABASE_ENGINE: 'sqlite' }), /OVERCORE_SQLITE_PATH não foi definido/)
})

test('motor sqlite recusa caminho relativo', () => {
  assert.throws(
    () => loadRuntimeConfig({ ...base, OVERCORE_DATABASE_ENGINE: 'sqlite', OVERCORE_SQLITE_PATH: 'overcore.db' }),
    /OVERCORE_SQLITE_PATH precisa ser absoluto/
  )
})

test('motor desconhecido é recusado', () => {
  assert.throws(
    () => loadRuntimeConfig({ ...base, OVERCORE_DATABASE_ENGINE: 'mysql', OVERCORE_DATABASE_URL: 'x' }),
    /OVERCORE_DATABASE_ENGINE precisa ser postgres ou sqlite/
  )
})
