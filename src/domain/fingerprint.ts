import { createHash } from 'node:crypto'

import type { ContextReference, Fingerprint, JsonObject, JsonValue, TaskRequest } from './types.js'

function normalize(value: unknown): JsonValue {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      if (item !== undefined) sorted[key] = normalize(item)
    }
    return sorted as JsonObject
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value
  }
  throw new TypeError(`Valor não serializável no fingerprint: ${typeof value}.`)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function fingerprint(value: unknown): Fingerprint {
  return { algorithm: 'sha256-jcs-v1', value: sha256(canonicalJson(value)) }
}

export function stableId(prefix: string, seed: string): string {
  return `${prefix}-${sha256(seed).slice('sha256:'.length, 'sha256:'.length + 24)}`
}

export function scopeKey(request: TaskRequest): string {
  const refs = request.context.references
    .filter((ref: ContextReference) => ref.kind === 'repository' || ref.kind === 'workspace')
    .map((ref: ContextReference) => `${ref.kind}:${ref.uri}`)
    .sort()
  const basis = refs.length > 0 ? refs : [`request:${request.requestId}`]
  return sha256(basis.join('\n'))
}
