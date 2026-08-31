import type { JsonObject } from '../../domain/types.js'
import { AuthorityProviderError, type AuthorityProvider } from '../../ports/task-store.js'

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
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: combined
      })
    } catch (error) {
      throw new AuthorityProviderError(
        'authority-provider-unavailable',
        true,
        `Authority Provider indisponível: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      const retryAfter = Number(response.headers.get('retry-after'))
      throw new AuthorityProviderError(
        retryable ? 'authority-provider-temporary-http' : 'authority-provider-rejected-http',
        retryable,
        `Authority Provider respondeu HTTP ${response.status}.`,
        retryable && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1_000 : undefined
      )
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      throw new AuthorityProviderError(
        'authority-provider-invalid-content-type',
        false,
        'Authority Provider não devolveu JSON.'
      )
    }
    try {
      return await response.json() as JsonObject
    } catch (error) {
      throw new AuthorityProviderError(
        'authority-provider-invalid-json',
        false,
        `Authority Provider devolveu JSON inválido: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
