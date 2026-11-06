/** Decisão do guarda de caminhos, sem acoplar a porta à implementação. */
export type RepositoryPathCheck =
  | { allowed: true; relativePath: string }
  | { allowed: false; reason: string; detail: string }

export interface RepositoryEditInput {
  taskId: string
  /** Worktree destacado do Overcore; o editor nunca recebe o repositório do proprietário. */
  worktreePath: string
  objective: string
  instructions: string
  pathScope: { include: string[]; exclude: string[] }
  /** Todo caminho lido ou escrito pelo editor passa por aqui antes do disco. */
  checkPath(candidate: string): Promise<RepositoryPathCheck>
  timeoutMs: number
  maxTokens?: number
  maxCostUsd?: number
}

export interface RepositoryEditOutcome {
  /** Relato em Markdown do que o editor fez; o diff medido é a prova, não este texto. */
  report: string
  tokens?: number
  costUsd?: number
}

/** Quem edita a bancada: agente real, ou script determinístico nos testes. */
export interface RepositoryEditor {
  edit(input: RepositoryEditInput, signal: AbortSignal): Promise<RepositoryEditOutcome>
}
