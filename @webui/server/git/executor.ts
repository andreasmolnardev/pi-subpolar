import { spawn } from 'node:child_process'

export const GIT_EXECUTABLE = '/usr/bin/git'
export const DEFAULT_GIT_TIMEOUT_MS = 10_000
export const DEFAULT_GIT_OUTPUT_BYTES = 2 * 1024 * 1024

export type GitExecutorOptions = { cwd: string; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; truncateOutput?: boolean }
export type GitCommandResult = { stdout: string; stderr: string; code: number; truncated?: boolean }
export type GitExecutor = (args: readonly string[], options: GitExecutorOptions) => Promise<GitCommandResult>

export class GitExecutionError extends Error {
  constructor(readonly kind: 'failed' | 'timeout' | 'output', message = 'Git operation failed') { super(message); this.name = 'GitExecutionError' }
}

/** Executes only the fixed Git binary with a minimal, non-credential environment. */
export const executeGit: GitExecutor = (args, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new GitExecutionError('timeout', 'Git operation cancelled')); return }
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  const maxBytes = options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES
  const child = spawn(GIT_EXECUTABLE, [...args], {
    cwd: options.cwd,
    shell: false,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
  })
  let stdout = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let settled = false
  const finish = (error?: Error, result?: GitCommandResult) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(result!) }
  const abort = () => { child.kill('SIGKILL'); finish(new GitExecutionError('timeout', 'Git operation cancelled')) }
  const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new GitExecutionError('timeout', 'Git operation timed out')) }, timeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })
  const append = (current: Buffer, chunk: Buffer) => Buffer.concat([current, chunk])
  const limit = () => { if (options.truncateOutput) { child.kill('SIGKILL'); finish(undefined, { stdout: stdout.subarray(0, maxBytes).toString('utf8'), stderr: '', code: 0, truncated: true }) } else { child.kill('SIGKILL'); finish(new GitExecutionError('output', 'Git output exceeded the limit')) } }
  child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); if (stdout.length + stderr.length > maxBytes) limit() })
  child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); if (stdout.length + stderr.length > maxBytes) limit() })
  child.on('error', () => finish(new GitExecutionError('failed')))
  child.on('close', (code) => code === 0 ? finish(undefined, { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), code }) : finish(new GitExecutionError('failed')))
})
