import { permittingDecision } from '../application/authorization.js'
import type { JsonObject } from '../domain/types.js'
import type { AuthorityProvider } from '../ports/task-store.js'

/** Somente testes e demonstração local. Nunca é selecionado pelo comando `serve`. */
export class PermittingAuthorityProvider implements AuthorityProvider {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async evaluate(request: JsonObject): Promise<JsonObject> {
    return permittingDecision(request, this.now())
  }
}
