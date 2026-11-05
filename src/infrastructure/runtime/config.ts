import { isAbsolute, join } from 'node:path'

/** PostgreSQL é o padrão; SQLite é o motor da casa única (ADR-023), sem caminho implícito. */
export type DatabaseConfig =
  | { engine: 'postgres'; url: string }
  | { engine: 'sqlite'; path: string }

export interface RuntimeConfig {
  database: DatabaseConfig
  host: '127.0.0.1'
  port: number
  localToken: string
  authorityProviderUrl: URL
  authorityProviderToken: string
  runtimeDirectory: string
  /** baseline não chama modelo; advisor inclui todos os perfis estruturais. */
  discoveryMode: 'baseline' | 'advisor'
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} não foi definido.`)
  return value
}

function loadDatabaseConfig(env: NodeJS.ProcessEnv): DatabaseConfig {
  const engine = env.OVERCORE_DATABASE_ENGINE ?? 'postgres'
  if (engine === 'postgres') return { engine, url: required(env, 'OVERCORE_DATABASE_URL') }
  if (engine !== 'sqlite') throw new Error('OVERCORE_DATABASE_ENGINE precisa ser postgres ou sqlite.')
  const path = required(env, 'OVERCORE_SQLITE_PATH')
  if (!isAbsolute(path)) throw new Error('OVERCORE_SQLITE_PATH precisa ser absoluto.')
  return { engine, path }
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const localAppData = env.LOCALAPPDATA
  if (!localAppData) throw new Error('LOCALAPPDATA não foi definido.')
  const host = env.OVERCORE_HOST ?? '127.0.0.1'
  if (host !== '127.0.0.1') throw new Error('OVERCORE_HOST v1 precisa ser 127.0.0.1.')
  const port = Number(env.OVERCORE_PORT ?? '0')
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('OVERCORE_PORT inválida.')
  const localToken = required(env, 'OVERCORE_LOCAL_TOKEN')
  const authorityProviderToken = required(env, 'OVERCORE_AUTHORITY_PROVIDER_TOKEN')
  const discoveryMode = env.OVERCORE_DISCOVERY_MODE ?? 'baseline'
  if (discoveryMode !== 'baseline' && discoveryMode !== 'advisor') {
    throw new Error('OVERCORE_DISCOVERY_MODE precisa ser baseline ou advisor.')
  }
  if (localToken.length < 16 || authorityProviderToken.length < 16) throw new Error('Tokens locais precisam de ao menos 16 caracteres.')
  return {
    database: loadDatabaseConfig(env),
    host,
    port,
    localToken,
    authorityProviderUrl: new URL(required(env, 'OVERCORE_AUTHORITY_PROVIDER_URL')),
    authorityProviderToken,
    runtimeDirectory: join(localAppData, 'Overcore'),
    discoveryMode
  }
}
