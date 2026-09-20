import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const e2eTempPrefix = 'subpolar-phase16-'
const credentials = {
  email: process.env.E2E_LIVE_EMAIL ?? 'e2e-admin@example.test',
  password: process.env.E2E_LIVE_PASSWORD ?? 'e2e-admin-password-16',
}

type Child = ReturnType<typeof Bun.spawn>

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a valid TCP port`)
  return value
}

async function waitFor(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(250)
  }
  throw new Error(`${label} did not become ready at ${url}: ${lastError}`)
}

function command(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) throw new Error('Configured command must not be empty')
  return parts
}

export type Harness = {
  baseUrl: string
  bridgeUrl: string
  pocketBaseUrl: string
  directory: string
  cleanup: () => Promise<void>
}

export async function startHarness(options: { keep?: boolean } = {}): Promise<Harness> {
  const keep = options.keep ?? process.env.E2E_KEEP_ARTIFACTS === 'true'
  const pocketBasePort = port('E2E_POCKETBASE_PORT', 48090)
  // Vite's checked-in proxy target is 127.0.0.1:4173; keep that boundary
  // unchanged while isolating the disposable stack from normal PB port 8090.
  const bridgePort = port('E2E_BRIDGE_PORT', 4173)
  const webPort = port('E2E_WEBUI_PORT', 48174)
  const directory = await mkdtemp(join(tmpdir(), e2eTempPrefix))
  const paths = {
    data: join(directory, 'pocketbase'),
    sessions: join(directory, 'sessions'),
    project: join(directory, 'project'),
    logs: join(directory, 'logs'),
    home: join(directory, 'home'),
  }
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })))
  const children: Child[] = []
  let cleaned = false

  const spawnLogged = (name: string, args: string[], env: Record<string, string>) => {
    const logPath = join(paths.logs, `${name}.log`)
    const file = Bun.file(logPath)
    const child = Bun.spawn(args, { cwd: root, env: { ...process.env, ...env }, stdout: file, stderr: file })
    children.push(child)
    console.log(`${name}: ${args.join(' ')} (log: ${logPath})`)
    return child
  }

  try {
    const pb = process.env.E2E_POCKETBASE_BIN ?? 'pocketbase'
    if (process.env.E2E_POCKETBASE_COMMAND) {
      spawnLogged('pocketbase', command(process.env.E2E_POCKETBASE_COMMAND, []), {})
    } else {
      const bootstrap = Bun.spawn([pb, '--dir', paths.data, 'superuser', 'upsert', credentials.email, credentials.password], {
        cwd: root,
        stdout: Bun.file(join(paths.logs, 'pocketbase-bootstrap.log')),
        stderr: Bun.file(join(paths.logs, 'pocketbase-bootstrap.log')),
      })
      if (await bootstrap.exited !== 0) throw new Error('PocketBase superuser bootstrap failed; see pocketbase-bootstrap.log')
      spawnLogged('pocketbase', [pb, '--dir', paths.data, 'serve', `--http=127.0.0.1:${pocketBasePort}`], {})
    }
    await waitFor(`http://127.0.0.1:${pocketBasePort}/api/health`, 'PocketBase')

    spawnLogged('bridge', command(process.env.E2E_BRIDGE_COMMAND, ['bun', '@webui/bridge.ts']), {
      POCKETBASE_URL: `http://127.0.0.1:${pocketBasePort}`,
      POCKETBASE_EMAIL: credentials.email,
      POCKETBASE_PASSWORD: credentials.password,
      ADMIN_EMAIL: credentials.email,
      ADMIN_PASSWORD: credentials.password,
      AUTH_REGISTRATION_ENABLED: 'false',
      AUTH_SECURE_COOKIES: 'false',
      WEBUI_PORT: String(bridgePort),
      PI_CODING_AGENT_DIR: paths.sessions,
      SUBPOLAR_PROJECT_ROOT: paths.project,
      HOME: paths.home,
      XDG_CONFIG_HOME: join(paths.home, '.config'),
      XDG_DATA_HOME: join(paths.home, '.local', 'share'),
      XDG_CACHE_HOME: join(paths.home, '.cache'),
    })
    await waitFor(`http://127.0.0.1:${bridgePort}/api/health`, 'bridge')

    spawnLogged('webui', command(process.env.E2E_WEBUI_COMMAND, ['npm', '--prefix', '@webui', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(webPort)]), {
      WEBUI_PORT: String(bridgePort),
      HOME: paths.home,
      XDG_CONFIG_HOME: join(paths.home, '.config'),
      XDG_DATA_HOME: join(paths.home, '.local', 'share'),
      XDG_CACHE_HOME: join(paths.home, '.cache'),
    })
    await waitFor(`http://127.0.0.1:${webPort}/`, 'WebUI')
    console.log(`isolated harness ready: http://127.0.0.1:${webPort}`)
    console.log(`credentials: ${credentials.email} / ${credentials.password}`)
    const cleanup = async () => {
      if (cleaned) return
      cleaned = true
      for (const child of children.slice().reverse()) child.kill('SIGTERM')
      const exits = await Promise.all(children.map((child) => Promise.race([
        child.exited.catch(() => -1),
        Bun.sleep(5_000).then(() => -1),
      ])))
      children.forEach((child, index) => { if (exits[index] === -1) child.kill('SIGKILL') })
      if (keep) console.error(`artifacts/logs: ${directory}`)
      else await rm(directory, { recursive: true, force: true })
    }
    return { baseUrl: `http://127.0.0.1:${webPort}`, bridgeUrl: `http://127.0.0.1:${bridgePort}`, pocketBaseUrl: `http://127.0.0.1:${pocketBasePort}`, directory, cleanup }
  } catch (error) {
    for (const child of children.slice().reverse()) child.kill('SIGTERM')
    const exits = await Promise.all(children.map((child) => Promise.race([
      child.exited.catch(() => -1),
      Bun.sleep(5_000).then(() => -1),
    ])))
    children.forEach((child, index) => { if (exits[index] === -1) child.kill('SIGKILL') })
    if (keep) console.error(`artifacts/logs: ${directory}`)
    else await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: bun e2e/harness.ts [--keep]')
    console.log('Starts isolated PocketBase, bridge, and Vite processes; requires Bun, PocketBase, and installed WebUI dependencies.')
    return
  }
  let harness: Harness | undefined
  try {
    harness = await startHarness()
    console.log('press Ctrl-C to stop; temporary data is removed on exit')
    await new Promise<void>((resolveExit) => process.once('SIGINT', resolveExit).once('SIGTERM', resolveExit))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    await harness?.cleanup()
  }
}

if (import.meta.main) await main()
