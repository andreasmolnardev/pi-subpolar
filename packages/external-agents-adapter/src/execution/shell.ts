import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import type { ExternalScope, IsolatedExecutionPort, IsolatedProcess, IsolatedProcessRequest } from '../runtime/contracts.ts'
import { canonicalRoot, immutableScope, scopedWorkingDirectory, within } from './workspace.ts'
import { safeEnvironment, type ShellPolicyPort } from './permissions.ts'

function quoted(value: string) { return JSON.stringify(value) }
function canonicalExecutable(value: string): string {
  const path = realpathSync(value)
  if (!path.startsWith('/') || !statSync(path).isFile()) throw new Error('An absolute regular executable is required')
  return path
}
/** No host fallback. SBPL restricts both files and all descendant process execution. */
export function createSandboxExecutionPort(): IsolatedExecutionPort {
  return { kind: process.platform === 'darwin' ? 'macos-seatbelt' : 'unavailable', interactive: false,
    async spawn(request: IsolatedProcessRequest): Promise<IsolatedProcess> {
      if (process.platform !== 'darwin') throw new Error('OS execution isolation is unavailable on this platform')
      if (request.signal?.aborted) throw new Error('Execution cancelled')
      const executable = canonicalExecutable(request.executable)
      const writable = request.writableRoots.map(canonicalRoot)
      const readable = request.readableRoots.map(canonicalRoot)
      const cwd = canonicalRoot(request.cwd)
      if (!readable.concat(writable).some(root => within(root, cwd))) throw new Error('Execution cwd is outside the isolated roots')
      if (writable.some(root => root === '/' || ['/Users', '/private', '/tmp', '/usr', '/System', '/Library'].includes(root))) throw new Error('Writable root is too broad')
      const allowed = (request.allowedExecutables ?? [executable]).map(canonicalExecutable)
      if (!allowed.includes(executable) || allowed.some(binary => writable.some(root => within(root, binary)))) throw new Error('Executable must be immutable and explicitly allowed')
      const ports = request.networkPorts ?? []
      if (ports.length > 16 || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid loopback network ports')
      const timeoutMs = request.timeoutMs ?? 120000
      const maxBytes = request.maxOutputBytes ?? 1048576
      if (timeoutMs < 1 || timeoutMs > 3600000 || maxBytes < 1 || maxBytes > 16777216) throw new Error('Invalid execution limits')
      const roots = [...new Set([...readable, ...writable])]
      // Runtime workspace discovery inspects ancestor directories, never their descendants.
      const ancestors = new Set<string>()
      for (const root of roots) { let parent = dirname(root); while (parent !== '/') { ancestors.add(parent); parent = dirname(parent) } }
      const profile = `(version 1)(deny default)
(allow file-read-metadata)
(allow process-fork)(allow process-info*)(allow sysctl-read)(allow mach-lookup)
(allow process-exec ${allowed.map(path => `(literal ${quoted(path)})`).join(' ')})
(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share/locale") (subpath "/usr/share/icu") (subpath "/private/var/db/timezone") ${[...ancestors].map(path => `(literal ${quoted(path)})`).join(' ')} (literal "/dev/urandom") (literal "/dev/random") ${allowed.map(path => `(literal ${quoted(path)})`).join(' ')} ${roots.map(root => `(subpath ${quoted(root)})`).join(' ')})
(allow file-read* file-write* (literal "/dev/null") ${writable.map(root => `(subpath ${quoted(root)})`).join(' ')})
${ports.length ? `(allow network-outbound ${ports.map(port => `(remote ip "127.0.0.1:${port}")`).join(' ')})` : ''}
${request.allowLoopbackServer ? '(allow network-bind (local ip "127.0.0.1"))(allow network-inbound (local ip "127.0.0.1"))(allow network-outbound (remote ip "127.0.0.1:*"))' : ''}`
      const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: writable[0] ?? cwd, TMPDIR: writable[0] ?? cwd, LANG: 'en_US.UTF-8' }
      for (const [key, value] of Object.entries(request.environment)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || value.includes('\0') || /^(?:DYLD_|LD_|NODE_OPTIONS$|BUN_OPTIONS$|ENV$|BASH_ENV$)/.test(key)) throw new Error('Unsafe process environment')
        env[key] = value
      }
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, ...request.args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      let total = 0
      let failure: Error | undefined
      let settled = false
      const kill = () => { if (child.pid && !settled) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }
      const timer = setTimeout(() => { failure = new Error('Isolated execution timed out'); kill() }, timeoutMs)
      const abort = () => { failure = new Error('Isolated execution cancelled'); kill() }
      request.signal?.addEventListener('abort', abort, { once: true })
      const bounded = async function* (stream: AsyncIterable<Uint8Array>) {
        for await (const chunk of stream) {
          total += chunk.length
          if (total > maxBytes) { failure = new Error('Isolated execution output limit exceeded'); kill(); break }
          yield chunk
        }
      }
      const stdout = bounded(child.stdout)
      const stderr = bounded(child.stderr)
      const exited = new Promise<number>((resolve, reject) => {
        const cleanup = () => { settled = true; clearTimeout(timer); request.signal?.removeEventListener('abort', abort) }
        child.once('error', error => { cleanup(); reject(error) })
        child.once('close', code => { cleanup(); failure ? reject(failure) : resolve(code ?? 1) })
      })
      // A caller may consume streams before awaiting exit; avoid transient unhandled rejection.
      void exited.catch(() => undefined)
      return { stdin: { write: data => { if (!settled) child.stdin.write(data) }, end: () => child.stdin.end() }, stdout, stderr, exited, stop: async () => { kill(); await exited.catch(() => undefined) } }
    },
  }
}

export class ControlledShell {
  readonly scope: ExternalScope
  private cwd: string
  private environment: Record<string, string> = {}
  constructor(scope: ExternalScope, private readonly execution: IsolatedExecutionPort, private readonly policy: ShellPolicyPort, private readonly allowedExecutables: readonly string[] = ['/bin/bash', '/bin/echo', '/bin/cat', '/bin/pwd', '/usr/bin/env']) {
    this.scope = immutableScope(scope); this.cwd = this.scope.workspace
  }
  setState(input: { cwd?: string; environment?: Readonly<Record<string, string>> }): void {
    const cwd = input.cwd ? scopedWorkingDirectory(this.scope, input.cwd) : this.cwd
    const environment = input.environment ? safeEnvironment(input.environment) : this.environment
    this.cwd = cwd; this.environment = { ...environment }
  }
  state() { return { cwd: this.cwd, environment: { ...this.environment } } }
  async run(input: { command: string; callId?: string; signal?: AbortSignal; timeoutMs?: number; onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 65536 || input.command.includes('\0')) throw new Error('Invalid shell command')
    const callId = input.callId ?? crypto.randomUUID()
    const command = input.command
    const cwd = scopedWorkingDirectory(this.scope, this.cwd)
    const event = { callId, command, cwd }
    const permission = await this.policy.authorize(this.scope, { command, cwd, environment: { ...this.environment } })
    if (!permission.allowed) { await this.policy.audit(this.scope, { ...event, state: 'denied', reason: permission.reason }); throw new Error(permission.reason ?? 'Shell execution denied') }
    await this.policy.audit(this.scope, { ...event, state: 'started' })
    try {
      const child = await this.execution.spawn({ executable: '/bin/bash', args: ['--noprofile', '--norc', '-c', command], cwd, environment: this.environment, readableRoots: [this.scope.workspace], writableRoots: [this.scope.workspace], allowedExecutables: this.allowedExecutables, signal: input.signal, timeoutMs: input.timeoutMs })
      child.stdin.end()
      const consume = async (stream: AsyncIterable<Uint8Array>, name: 'stdout' | 'stderr') => { let output = ''; for await (const chunk of stream) { const text = Buffer.from(chunk).toString('utf8'); output += text; input.onOutput?.(name, text) }; return output }
      const [stdout, stderr, exitCode] = await Promise.all([consume(child.stdout, 'stdout'), consume(child.stderr, 'stderr'), child.exited])
      await this.policy.audit(this.scope, { ...event, state: 'completed', exitCode })
      return { stdout, stderr, exitCode }
    } catch (error) { await this.policy.audit(this.scope, { ...event, state: 'failed', reason: error instanceof Error ? error.message : 'Execution failed' }); throw error }
  }
}
