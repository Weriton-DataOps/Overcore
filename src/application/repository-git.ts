import { execFile } from 'node:child_process'

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

/**
 * Variáveis que um processo filho da bancada pode herdar.
 *
 * É lista de permissão, não de bloqueio: `OVERCORE_*`, tokens, credenciais do
 * Claude, chaves de API e qualquer `GIT_*` que redirecione o repositório ficam
 * de fora por construção (ADR-022, contenção da verificação).
 */
const INHERITED = new Set([
  'path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir',
  'home', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata',
  'programfiles', 'programfiles(x86)', 'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)',
  'number_of_processors', 'processor_architecture', 'os', 'username', 'user', 'logname',
  'lang', 'lc_all', 'tz', 'term'
])

export function sanitizedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && INHERITED.has(name.toLowerCase())) env[name] = value
  }
  return { ...env, ...extra }
}

export function runProcess(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      ...(options.signal ? { signal: options.signal } : {})
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr, exitCode: 0, timedOut: false })
      const failure = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string | null }
      if (typeof failure.code === 'number') {
        return resolve({ stdout, stderr, exitCode: failure.code, timedOut: false })
      }
      if (failure.killed && !options.signal?.aborted) {
        return resolve({ stdout, stderr, exitCode: -1, timedOut: true })
      }
      reject(error)
    })
  })
}

const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null'

/**
 * Git sem hooks, sem fsmonitor e sem herdar variáveis que redirecionem o
 * repositório: hook é código do repositório, e a bancada não executa código
 * do repositório fora da verificação declarada.
 */
export function runGit(
  cwd: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ProcessResult> {
  return runProcess('git', ['-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env: sanitizedEnvironment(process.env, { GIT_TERMINAL_PROMPT: '0' }),
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.signal ? { signal: options.signal } : {})
  })
}

/** Igual a `runGit`, mas falha quando o Git não termina com sucesso. */
export async function git(
  cwd: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string> {
  const result = await runGit(cwd, args, options)
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 500)
    throw new Error(`git ${args[0]} falhou (${result.timedOut ? 'timeout' : `código ${result.exitCode}`}): ${detail}`)
  }
  return result.stdout
}
