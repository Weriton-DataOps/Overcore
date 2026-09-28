import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface RepositoryPathScope {
  include: string[]
  exclude: string[]
}

export type PathDenialReason =
  | 'invalid-path'
  | 'outside-worktree'
  | 'escapes-through-link'
  | 'git-metadata'
  | 'not-included'
  | 'excluded'

export type PathDecision =
  | { allowed: true; relativePath: string }
  | { allowed: false; reason: PathDenialReason; detail: string }

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Converte um glob relativo em expressão regular sobre caminhos com `/`.
 *
 * `*` e `?` nunca atravessam diretórios; `**` só atravessa quando ocupa um
 * segmento inteiro. Colchetes e chaves não são suportados e valem como texto.
 */
export function repositoryGlobToRegExp(glob: string, caseInsensitive: boolean): RegExp {
  assertRelativeGlob(glob)
  let pattern = '^'
  let index = 0
  while (index < glob.length) {
    const char = glob.charAt(index)
    if (char === '*') {
      if (glob[index + 1] === '*') {
        const startsSegment = index === 0 || glob[index - 1] === '/'
        const next = glob[index + 2]
        if (startsSegment && next === '/') {
          pattern += '(?:[^/]*/)*'
          index += 3
          continue
        }
        if (startsSegment && next === undefined) {
          pattern += '.*'
          index += 2
          continue
        }
        pattern += '[^/]*'
        index += 2
        continue
      }
      pattern += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      pattern += '[^/]'
      index += 1
      continue
    }
    pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    index += 1
  }
  return new RegExp(`${pattern}$`, caseInsensitive ? 'i' : '')
}

function assertRelativeGlob(glob: string): void {
  if (
    glob.length === 0 ||
    glob.includes('\0') ||
    glob.includes('\\') ||
    glob.startsWith('/') ||
    /^[A-Za-z]:/.test(glob) ||
    glob.split('/').includes('..')
  ) {
    throw new Error(`Glob de escopo inválido: ${JSON.stringify(glob)}.`)
  }
}

/**
 * Guarda de caminho da bancada (ADR-022).
 *
 * Decide pelo caminho físico: o destino é resolvido pelo ancestral existente
 * mais próximo com `realpath`, então link simbólico, junção e nome curto 8.3
 * não disfarçam uma escrita fora do worktree ou dentro de `.git`. O texto do
 * caminho também é recusado quando usa forma que o Windows reinterpreta.
 */
export class RepositoryPathGuard {
  private readonly include: RegExp[]
  private readonly exclude: RegExp[]

  private constructor(
    private readonly root: string,
    scope: RepositoryPathScope,
    private readonly windows: boolean
  ) {
    if (scope.include.length === 0) throw new Error('O escopo da bancada exige ao menos um glob de inclusão.')
    this.include = scope.include.map((glob) => repositoryGlobToRegExp(glob, windows))
    this.exclude = scope.exclude.map((glob) => repositoryGlobToRegExp(glob, windows))
  }

  static async create(
    worktreeRoot: string,
    scope: RepositoryPathScope,
    platform: NodeJS.Platform = process.platform
  ): Promise<RepositoryPathGuard> {
    const root = await realpath(worktreeRoot)
    return new RepositoryPathGuard(root, scope, platform === 'win32')
  }

  async check(candidate: string): Promise<PathDecision> {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
      return deny('invalid-path', 'Caminho vazio ou com caractere nulo.')
    }
    const lexical = resolve(this.root, candidate)
    const lexicalRelative = relative(this.root, lexical)
    const lexicalInside = isInside(lexicalRelative)

    const segments = lexicalInside ? lexicalRelative.split(sep) : []
    for (const segment of segments) {
      const invalid = this.invalidSegment(segment)
      if (invalid) return deny('invalid-path', invalid)
    }

    let physical: string
    try {
      physical = await this.physicalPath(lexical)
    } catch (error) {
      return deny('invalid-path', `Não foi possível resolver o caminho: ${(error as Error).message}`)
    }
    const physicalRelative = relative(this.root, physical)
    if (!isInside(physicalRelative)) {
      return lexicalInside
        ? deny('escapes-through-link', 'O caminho sai do worktree por link simbólico ou junção.')
        : deny('outside-worktree', 'O caminho está fora do worktree.')
    }
    if (physicalRelative === '') return deny('invalid-path', 'A raiz do worktree não é um arquivo editável.')

    const physicalSegments = physicalRelative.split(sep)
    if ([...segments, ...physicalSegments].some((segment) => this.isGitSegment(segment))) {
      return deny('git-metadata', 'Metadados do Git não podem ser lidos ou alterados pelo agente.')
    }

    const relativePath = physicalSegments.join('/')
    if (!this.include.some((pattern) => pattern.test(relativePath))) {
      return deny('not-included', `${relativePath} está fora do escopo de inclusão.`)
    }
    if (this.exclude.some((pattern) => pattern.test(relativePath))) {
      return deny('excluded', `${relativePath} corresponde a um glob de exclusão.`)
    }
    return { allowed: true, relativePath }
  }

  /** Resolve pelo ancestral existente mais próximo e reanexa o restante. */
  private async physicalPath(target: string): Promise<string> {
    const pending: string[] = []
    let current = target
    for (;;) {
      try {
        await lstat(current)
        const real = await realpath(current)
        return pending.length === 0 ? real : join(real, ...pending.reverse())
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = resolve(current, '..')
        if (parent === current) throw error
        pending.push(current.slice(parent.length).replace(/^[\\/]+/, ''))
        current = parent
      }
    }
  }

  private invalidSegment(segment: string): string | null {
    if (!this.windows) return null
    if (segment.includes(':')) return `O segmento ${JSON.stringify(segment)} usa fluxo alternativo de dados.`
    if (/[. ]$/.test(segment)) return `O segmento ${JSON.stringify(segment)} termina com ponto ou espaço.`
    if (WINDOWS_RESERVED.test(segment)) return `O segmento ${JSON.stringify(segment)} é um nome reservado do Windows.`
    return null
  }

  private isGitSegment(segment: string): boolean {
    const normalized = this.windows ? segment.replace(/[. ]+$/, '').toLowerCase() : segment
    return normalized === '.git' || (this.windows && /^git~\d+$/.test(normalized))
  }
}

function isInside(relativePath: string): boolean {
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function deny(reason: PathDenialReason, detail: string): PathDecision {
  return { allowed: false, reason, detail }
}
