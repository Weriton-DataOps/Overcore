import type { JsonObject } from '../../domain/types.js'
import { AuthorityProviderError, type AuthorityProvider } from '../../ports/task-store.js'

/**
 * Motivo da recusa como o provedor o escreveu, para o bloqueio dizer por que parou.
 *
 * O texto vai para o motivo do bloqueio e para a leitura da API, então entra curto e sem
 * caractere de controle; corpo que não seja JSON com `error`/`message` em texto é ignorado.
 */
async function rejectionReason(response: Response): Promise<string> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return '.'
  }
  if (typeof body !== 'object' || body === null) return '.'
  const { error, message } = body as { error?: unknown, message?: unknown }
  const code = typeof error === 'string' ? bounded(error, 64) : ''
  const detail = typeof message === 'string' ? bounded(message, 400) : ''
  return `${code ? ` (${code})` : ''}${detail ? `: ${detail}` : '.'}`
}

function bounded(text: string, limit: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '?').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

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
        `Authority Provider respondeu HTTP ${response.status}${await rejectionReason(response)}`,
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
