import { join } from 'node:path'

export interface RuntimeConfig {
  databaseUrl: string
  host: '127.0.0.1'
  port: number
  localToken: string
  authorityProviderUrl: URL
  authorityProviderToken: string
  runtimeDirectory: string
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} não foi definido.`)
  return value
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
  if (localToken.length < 16 || authorityProviderToken.length < 16) throw new Error('Tokens locais precisam de ao menos 16 caracteres.')
  return {
    databaseUrl: required(env, 'OVERCORE_DATABASE_URL'),
    host,
    port,
    localToken,
    authorityProviderUrl: new URL(required(env, 'OVERCORE_AUTHORITY_PROVIDER_URL')),
    authorityProviderToken,
    runtimeDirectory: join(localAppData, 'Overcore')
  }
}
