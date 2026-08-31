import type { JsonObject } from '../../domain/types.js'
import type { AuthorityProvider } from '../../ports/task-store.js'

export class HttpAuthorityProvider implements AuthorityProvider {
  constructor(
    private readonly endpoint: URL,
    private readonly token: string,
    private readonly timeoutMs = 10_000
  ) {
    if (endpoint.protocol !== 'http:' || (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost')) {
      throw new Error('Authority Provider v1 precisa ser HTTP local em loopback.')
    }
    if (token.length < 16) throw new Error('Token do Authority Provider é curto demais.')
  }

  async evaluate(request: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(request),
      signal: combined
    })
    if (!response.ok) throw new Error(`Authority Provider respondeu HTTP ${response.status}.`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) throw new Error('Authority Provider não devolveu JSON.')
    return await response.json() as JsonObject
  }
}
