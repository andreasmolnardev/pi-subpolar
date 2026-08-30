import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

type Project = { name: string; path: string }
type SessionRecord = {
  id: string
  project: string
  title: string
  createdAt: number
  updatedAt: number
}
type RpcCommand = Record<string, unknown> & { type: string }
type RpcMessage = Record<string, unknown> & { type?: string; id?: string }
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type SocketData = { sessionId: string; unsubscribe?: () => void }

const root = resolve(import.meta.dir, '..')
const webuiDir = import.meta.dir
const statePath = join(webuiDir, '.sessions.json')
const port = Number(process.env.WEBUI_PORT ?? 4173)
const allowedRpcCommands = new Set([
  'prompt', 'steer', 'follow_up', 'abort', 'clear_queue', 'new_session', 'get_state',
  'set_model', 'cycle_model', 'get_available_models', 'set_thinking_level',
  'cycle_thinking_level', 'get_available_thinking_levels', 'set_steering_mode',
  'set_follow_up_mode', 'compact', 'set_auto_compaction', 'set_auto_retry', 'abort_retry',
  'get_session_stats', 'get_entries', 'get_tree', 'get_last_assistant_text', 'set_session_name',
  'get_messages', 'get_commands', 'fork', 'clone', 'get_fork_messages',
])
const extensionPaths = [
  'agent-profiles.ts',
  'projects.ts',
  'usage.ts',
  'session-title.ts',
  'session-history-search.ts',
  'list-tools.ts',
  'openapi-tools.ts',
].map((file) => join(root, '@extensions', file))

function loadState(): SessionRecord[] {
  if (!existsSync(statePath)) return []
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
    return Array.isArray(value) ? value.filter(isSessionRecord) : []
  } catch {
    return []
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<SessionRecord>
  return typeof item.id === 'string' && typeof item.project === 'string' && typeof item.title === 'string'
    && typeof item.createdAt === 'number' && typeof item.updatedAt === 'number'
}

let sessions = loadState()

async function saveState(): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8')
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readProjectsFile(filePath: string, base: string): Project[] {
  if (!existsSync(filePath)) return []
  try {
    const source = object(JSON.parse(readFileSync(filePath, 'utf8')))
    const entries = object(source.projects ?? source)
    return Object.entries(entries).flatMap(([name, value]) => {
      const path = typeof value === 'string' ? value : object(value).path
      return typeof path === 'string' ? [{ name, path: resolve(base, path) }] : []
    })
  } catch {
    return []
  }
}

function projects(): Project[] {
  const values = [
    { name: 'pi-subpolar', path: root },
    ...readProjectsFile(join(homedir(), '.pi', 'projects.json'), homedir()),
    ...readProjectsFile(join(homedir(), '.pi', 'agent', 'projects.json'), homedir()),
    ...readProjectsFile(join(root, '.pi', 'projects.json'), root),
  ]
  return [...new Map(values.map((project) => [project.name, project])).values()]
}

function projectFor(name: string | undefined): Project {
  const value = projects().find((project) => project.name === name)
  if (!value) throw new Error(`Unknown project: ${name ?? ''}`)
  return value
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return object(await request.json())
  } catch {
    return {}
  }
}

function sessionMessageText(message: unknown): string {
  const value = object(message)
  const content = value.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => {
    const item = object(part)
    return typeof item.text === 'string' ? [item.text] : typeof item.thinking === 'string' ? [item.thinking] : []
  }).join('\n')
}

class PiRpcSession {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private sequence = 0

  constructor(readonly record: SessionRecord, project: Project) {
    const args = ['--mode', 'rpc', '--session-id', record.id, '--no-approve', '--no-extensions']
    for (const extensionPath of extensionPaths) args.push('--extension', extensionPath)
    this.process = spawn('pi', args, { cwd: project.path, stdio: ['pipe', 'pipe', 'pipe'] })
    this.process.stdout.on('data', (chunk: Buffer) => this.read(chunk))
    this.process.stderr.on('data', () => undefined)
    this.process.on('close', () => {
      for (const request of this.pending.values()) request.reject(new Error('Pi RPC process exited'))
      this.pending.clear()
    })
  }

  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) continue
      try {
        this.handle(JSON.parse(line) as RpcMessage)
      } catch {
        continue
      }
    }
  }

  private handle(message: RpcMessage): void {
    if (message.type === 'response' && message.id) {
      const request = this.pending.get(message.id)
      if (request) {
        this.pending.delete(message.id)
        if (message.success === false) request.reject(new Error(String(message.error ?? 'Pi RPC command failed')))
        else request.resolve(message)
      }
    }
    for (const listener of this.listeners) listener(message)
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(command: RpcCommand): Promise<unknown> {
    const id = `webui-${++this.sequence}`
    const message = { ...command, id }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.process.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }

  close(): void {
    this.process.stdin.end()
    this.process.kill('SIGTERM')
  }
}

const active = new Map<string, PiRpcSession>()

function shutdown(): void {
  for (const session of active.values()) session.close()
  active.clear()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function recordFor(id: string): SessionRecord {
  const record = sessions.find((session) => session.id === id)
  if (!record) throw new Error(`Unknown session: ${id}`)
  return record
}

function rpcSession(id: string): PiRpcSession {
  const existing = active.get(id)
  if (existing) return existing
  const record = recordFor(id)
  const session = new PiRpcSession(record, projectFor(record.project))
  active.set(id, session)
  return session
}

async function sendRpc(id: string, command: RpcCommand): Promise<unknown> {
  if (!allowedRpcCommands.has(command.type)) throw new Error(`Unsupported RPC command: ${command.type}`)
  const session = rpcSession(id)
  const result = await session.send(command) as RpcMessage
  const record = recordFor(id)
  record.updatedAt = Date.now()
  await saveState()
  return result
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['authorization', 'authorizationtoken', 'apikey', 'api-key', 'token', 'password', 'secret'].some((part) => key.toLowerCase().includes(part))) {
      return [key, '[redacted]']
    }
    return [key, redactConfig(item)]
  }))
}

function openApiProviders(): Record<string, unknown> {
  const files = [join(homedir(), '.pi', 'tools.json'), join(homedir(), '.pi', 'agent', 'tools.json'), join(root, '.pi', 'tools.json')]
  const providers: Record<string, unknown> = {}
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      const parsed = object(JSON.parse(readFileSync(file, 'utf8')))
      Object.assign(providers, object(parsed.providers ?? parsed.tools ?? parsed))
    } catch {
      continue
    }
  }
  return redactConfig(providers) as Record<string, unknown>
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.split('/').filter(Boolean)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ status: 'ok', activeSessions: active.size })
  if (request.method === 'GET' && url.pathname === '/api/projects') return json({ projects: projects() })

  if (path[0] !== 'api') return json({ error: 'Not found' }, 404)

  if (path[1] === 'sessions' && path.length === 2 && request.method === 'GET') {
    const project = url.searchParams.get('project')
    return json({ sessions: sessions.filter((session) => !project || session.project === project).sort((a, b) => b.updatedAt - a.updatedAt) })
  }

  if (path[1] === 'sessions' && path.length === 2 && request.method === 'POST') {
    const input = await body(request)
    const project = projectFor(typeof input.project === 'string' ? input.project : undefined)
    const now = Date.now()
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      project: project.name,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled session',
      createdAt: now,
      updatedAt: now,
    }
    sessions.push(record)
    await saveState()
    rpcSession(record.id)
    return json({ session: record }, 201)
  }

  if (path[1] === 'sessions' && path.length >= 3) {
    const id = decodeURIComponent(path[2] ?? '')
    try {
      recordFor(id)
      if (path.length === 3 && request.method === 'PATCH') {
        const input = await body(request)
        const title = typeof input.title === 'string' ? input.title.trim() : ''
        if (title) {
          await sendRpc(id, { type: 'set_session_name', name: title })
          recordFor(id).title = title
          await saveState()
        }
        return json({ session: recordFor(id) })
      }
      if (path.length === 3 && request.method === 'DELETE') {
        active.get(id)?.close()
        active.delete(id)
        sessions = sessions.filter((session) => session.id !== id)
        await saveState()
        return json({ ok: true })
      }
      if (path.length === 4 && path[3] === 'messages' && request.method === 'GET') return json(await sendRpc(id, { type: 'get_messages' }))
      if (path.length === 4 && path[3] === 'state' && request.method === 'GET') return json(await sendRpc(id, { type: 'get_state' }))
      if (path.length === 4 && path[3] === 'stats' && request.method === 'GET') return json(await sendRpc(id, { type: 'get_session_stats' }))
      if (path.length === 4 && path[3] === 'rpc' && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.type !== 'string') return json({ error: 'RPC type is required' }, 400)
        return json(await sendRpc(id, input as RpcCommand))
      }
      if (path.length === 4 && path[3] === 'prompt' && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.message !== 'string' || !input.message.trim()) return json({ error: 'Prompt message is required' }, 400)
        return json(await sendRpc(id, { type: 'prompt', message: input.message, ...(typeof input.streamingBehavior === 'string' ? { streamingBehavior: input.streamingBehavior } : {}) }))
      }
      if (path.length === 4 && path[3] === 'abort' && request.method === 'POST') return json(await sendRpc(id, { type: 'abort' }))
      return json({ error: 'Not found' }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  }

  if (path[1] === 'extensions' && path[2] === 'projects') {
    if (request.method === 'GET') return json({ projects: projects() })
    if (request.method === 'POST') {
      const input = await body(request)
      if (typeof input.sessionId !== 'string' || typeof input.project !== 'string') return json({ error: 'sessionId and project are required' }, 400)
      projectFor(input.project)
      return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/project ${input.project}` }))
    }
  }

  if (path[1] === 'extensions' && (path[2] === 'profiles' || path[2] === 'agent-profiles') && request.method === 'GET') {
    const files = [join(homedir(), '.pi', 'agent', 'agents.json'), join(root, '.pi', 'agents.json')]
    const profiles: Record<string, unknown> = { master: { systemPrompt: "Pi's normal runtime prompt", tools: [] } }
    for (const file of files) {
      if (!existsSync(file)) continue
      try { Object.assign(profiles, JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) } catch { continue }
    }
    return json({ profiles: redactConfig(profiles) })
  }

  if (path[1] === 'extensions' && (path[2] === 'profiles' || path[2] === 'agent-profiles') && path[3] === 'activate' && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.sessionId !== 'string' || typeof input.profile !== 'string') return json({ error: 'sessionId and profile are required' }, 400)
    return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/profile ${input.profile}` }))
  }

  if (path[1] === 'extensions' && (path[2] === 'tools' || path[2] === 'list-tools') && request.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return json({ tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'] })
    return json({ tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'], commands: await sendRpc(sessionId, { type: 'get_commands' }) })
  }

  if (path[1] === 'extensions' && path[2] === 'commands' && request.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return json({ commands: [] })
    return json(await sendRpc(sessionId, { type: 'get_commands' }))
  }

  if (path[1] === 'extensions' && path[2] === 'command' && path[3] && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.sessionId !== 'string') return json({ error: 'sessionId is required' }, 400)
    const args = typeof input.args === 'string' && input.args.trim() ? ` ${input.args.trim()}` : ''
    return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/${decodeURIComponent(path[3])}${args}` }))
  }

  if (path[1] === 'extensions' && (path[2] === 'session-search' || path[2] === 'session-history-search') && request.method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').toLocaleLowerCase().trim()
    if (!query) return json({ sessions: [] })
    const matches = []
    for (const record of sessions) {
      try {
        const response = await sendRpc(record.id, { type: 'get_messages' }) as RpcMessage
        const messages = object(response.data).messages
        const text = Array.isArray(messages) ? messages.map(sessionMessageText).join('\n') : ''
        if (`${record.title}\n${text}`.toLocaleLowerCase().includes(query)) matches.push(record)
      } catch {
        continue
      }
    }
    return json({ sessions: matches })
  }

  if (path[1] === 'extensions' && path[2] === 'usage' && request.method === 'GET') {
    const values = []
    for (const record of sessions) {
      try {
        const response = await sendRpc(record.id, { type: 'get_session_stats' }) as RpcMessage
        values.push({ session: record, stats: response.data ?? null })
      } catch {
        values.push({ session: record, stats: null })
      }
    }
    return json({ sessions: values })
  }

  if (path[1] === 'extensions' && path[2] === 'session-title') {
    if (request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId')
      return json({ title: sessionId ? recordFor(sessionId).title : null })
    }
    if (request.method === 'POST') {
      const input = await body(request)
      if (typeof input.sessionId !== 'string' || typeof input.title !== 'string' || !input.title.trim()) return json({ error: 'sessionId and title are required' }, 400)
      const response = await sendRpc(input.sessionId, { type: 'set_session_name', name: input.title.trim() })
      const record = recordFor(input.sessionId)
      record.title = input.title.trim()
      await saveState()
      return json({ response, session: record })
    }
  }

  if (path[1] === 'extensions' && path[2] === 'openapi-tools' && request.method === 'GET') return json({ providers: openApiProviders() })
  return json({ error: 'Not found' }, 404)
}

const server = Bun.serve<SocketData>({
  port,
  hostname: '127.0.0.1',
  async fetch(request, server) {
    const origin = request.headers.get('origin')
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json({ error: 'Origin not allowed' }, 403)
    const url = new URL(request.url)
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)
    if (match && server.upgrade(request, { data: { sessionId: decodeURIComponent(match[1] ?? '') } })) return undefined
    const response = await handle(request)
    response.headers.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    response.headers.set('access-control-allow-headers', 'content-type')
    if (origin) response.headers.set('access-control-allow-origin', origin)
    return response
  },
  websocket: {
    open(socket) {
      try {
        const session = rpcSession(socket.data.sessionId)
        socket.data.unsubscribe = session.onMessage((message) => socket.send(JSON.stringify(message)))
      } catch {
        socket.close(1011, 'Unknown session')
      }
    },
    close(socket) {
      const unsubscribe = socket.data.unsubscribe as unknown as (() => void) | undefined
      unsubscribe?.()
    },
    message() {
      return
    },
  },
})
