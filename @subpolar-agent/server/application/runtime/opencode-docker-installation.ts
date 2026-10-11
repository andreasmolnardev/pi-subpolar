import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const COMPOSE_FILE = resolve(ROOT, 'deployment/external-agent-runtime/compose.yaml')
const VERIFY_SCRIPT = resolve(ROOT, 'deployment/external-agent-runtime/verify-docker-acp.mjs')
const VERSION = '2.0.26'
const BINARY = '/var/lib/subpolar/opencode/opencode'
const MAX_OUTPUT = 128 * 1024
const TIMEOUT_MS = 10 * 60_000

export type DockerCommand = (args: readonly string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>

export class OpenCodeDockerInstallation {
  constructor(private readonly run: DockerCommand, private readonly verifyAcp: () => Promise<void>) {}

  private compose(...args: string[]) {
    return this.run(['compose', '-f', COMPOSE_FILE, '--profile', 'external-agent-runtime', ...args])
  }

  async status() {
    const { stdout } = await this.compose('ps', '--format', 'json', 'opencode-v2')
    const rows = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    const running = rows.some((row) => row.State === 'running' || row.State === 'Up')
    let version: string | undefined
    let binarySha256: string | undefined
    if (running) {
      const result = await this.compose('exec', '-T', 'opencode-v2', 'sh', '-c', `${BINARY} --version && sha256sum ${BINARY}`)
      const lines = result.stdout.trim().split('\n')
      version = lines[0]
      binarySha256 = lines[1]?.split(/\s+/)[0]
    }
    return {
      provider: 'opencode-v2',
      expectedVersion: VERSION,
      installed: running && version === `opencode v${VERSION}` && Boolean(binarySha256),
      running,
      ...(version ? { version } : {}),
      ...(binarySha256 ? { binarySha256 } : {}),
      persistentVolume: 'opencode_installation',
    }
  }

  async install() {
    await this.compose('build', 'opencode-v2')
    await this.compose('up', '-d', 'opencode-v2')
    return this.status()
  }

  async check() {
    const status = await this.status()
    if (!status.installed || !status.running) throw new Error('OpenCode Docker runtime is not installed and running')
    const [containerCheck] = await Promise.all([
      this.run(['compose', '-f', COMPOSE_FILE, '--profile', 'external-agent-runtime', 'exec', '-T', 'opencode-v2', 'sh', '-c', `test "$(id -u)" = 10001 && test ! -w ${BINARY} && test ! -e /dev-workspace && ${BINARY} --version`]),
      this.run(['compose', '-f', COMPOSE_FILE, '--profile', 'external-agent-runtime', 'exec', '-T', 'opencode-v2', 'sha256sum', BINARY]),
      this.verifyAcp(),
    ])
    if (!containerCheck.stdout.includes(`opencode v${VERSION}`)) throw new Error('OpenCode Docker runtime verification failed')
    return { ...status, verified: true, acp: 'initialize/session-new/session-close' }
  }
}

export const dockerCommand: DockerCommand = (args, timeoutMs = TIMEOUT_MS) => new Promise((resolvePromise, reject) => {
  if (args.some((arg) => arg.includes('\0'))) return reject(new Error('Invalid Docker argument'))
  const child = spawn('docker', [...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  let settled = false
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    error ? reject(error) : resolvePromise({ stdout, stderr })
  }
  const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    if (stdout.length + stderr.length + chunk.length > MAX_OUTPUT) {
      child.kill('SIGKILL')
      finish(new Error('Docker runtime command output exceeded its limit'))
      return
    }
    if (target === 'stdout') stdout += chunk.toString('utf8')
    else stderr += chunk.toString('utf8')
  }
  child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
  child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
  child.on('error', () => finish(new Error('Docker runtime manager is unavailable')))
  child.on('close', (code) => code === 0 ? finish() : finish(new Error('Docker runtime command failed')))
  const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Docker runtime command timed out')) }, timeoutMs)
})

export function createOpenCodeDockerInstallation(enabled = process.env.SUBPOLAR_ENABLE_OPENCODE_DOCKER_INSTALLER === '1') {
  if (!enabled) return undefined
  const verifyAcp = () => new Promise<void>((resolvePromise, reject) => {
    const child = spawn('bun', [VERIFY_SCRIPT], { cwd: ROOT, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('OpenCode ACP check timed out')) }, TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); reject(new Error('OpenCode ACP verifier is unavailable')) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && output.includes('"sessionLifecycle":"passed"')) resolvePromise()
      else reject(new Error('OpenCode ACP lifecycle check failed'))
    })
  })
  return new OpenCodeDockerInstallation(dockerCommand, verifyAcp)
}
