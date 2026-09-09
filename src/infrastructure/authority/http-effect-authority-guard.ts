import { fingerprint } from '../../domain/fingerprint.js'
import type { JsonObject } from '../../domain/types.js'
import type {
  EffectAuthorizationCheck,
  EffectAuthorizationEvidence,
  EffectAuthorityGuard
} from '../../ports/effect-journal-store.js'

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} invalido.`)
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} invalido.`)
  return value
}

function sameEffect(binding: JsonObject, check: EffectAuthorizationCheck): boolean {
  return binding.actionId === check.actionId &&
    binding.effectKey === check.effectKey &&
    binding.resourceRef === check.resourceRef &&
    binding.operation === check.operation
}

/**
 * Consulta o Omni imediatamente antes da escrita. Esta porta nao autoriza por
 * conta propria: qualquer indisponibilidade, contrato inesperado ou resposta
 * diferente de `active` interrompe o Harness antes do atomicWrite.
 */
export class HttpEffectAuthorityGuard implements EffectAuthorityGuard {
  constructor(
    private readonly endpoint: URL,
    private readonly token: string,
    private readonly timeoutMs = 10_000
  ) {
    if (
      endpoint.protocol !== 'http:' ||
      (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') ||
      endpoint.pathname !== '/v1/authority/revalidate-effect'
    ) throw new Error('Guardiao de efeitos exige o endpoint loopback de revalidacao do Omni.')
    if (token.length < 16) throw new Error('Token do guardiao de efeitos e curto demais.')
  }

  async assertActive(check: EffectAuthorizationCheck): Promise<EffectAuthorizationEvidence> {
    if (!check.authorizationRequest || !check.actionId) {
      throw new Error('Efeito journaled exige pedido de autorizacao e actionId para revalidacao.')
    }
    const signal = AbortSignal.timeout(this.timeoutMs)
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          contractVersion: '1.0',
          authorizationRequest: check.authorizationRequest,
          effect: {
            actionId: check.actionId,
            effectKey: check.effectKey,
            resourceRef: check.resourceRef,
            operation: check.operation
          }
        }),
        signal
      })
    } catch (error) {
      throw new Error(`Revalidacao do Omni indisponivel; efeito nao aplicado: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`Revalidacao do Omni recusou o efeito (HTTP ${response.status}).`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) throw new Error('Revalidacao do Omni nao devolveu JSON.')
    const result = object(await response.json(), 'resposta de revalidacao')
    const requestId = text(check.authorizationRequest.authorizationRequestId, 'authorizationRequestId')
    const effectBinding = object(result.effectBinding, 'effectBinding')
    if (
      result.contractVersion !== '1.0' ||
      result.status !== 'active' ||
      result.authorizationRequestId !== requestId ||
      !sameEffect(effectBinding, check)
    ) throw new Error('Revalidacao do Omni nao confirmou a mesma autorizacao e o mesmo efeito.')
    const evidence = object(result.evidenceFingerprint, 'evidenceFingerprint')
    if (evidence.algorithm !== 'sha256-jcs-v1' || !/^sha256:[a-f0-9]{64}$/.test(String(evidence.value))) {
      throw new Error('Revalidacao do Omni devolveu evidencia sem fingerprint valido.')
    }
    return {
      checkedAt: text(result.checkedAt, 'checkedAt'),
      evidenceId: text(result.revalidationId, 'revalidationId'),
      digest: evidence.value as `sha256:${string}`
    }
  }
}

export function revalidationEvidenceFingerprint(check: EffectAuthorizationCheck, checkedAt: string): `sha256:${string}` {
  return fingerprint({
    taskId: check.taskId,
    effectKey: check.effectKey,
    actionId: check.actionId,
    checkedAt
  }).value
}
