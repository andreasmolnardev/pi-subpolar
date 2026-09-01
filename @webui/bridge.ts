import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { entriesPayload, projectEntries, type TranscriptMessage } from './transcript/projector'

type Project = { name: string; path: string }
type SessionRecord = {
  id: string
  project: string
  title: string
  createdAt: number
  updatedAt: number
  profile?: string
  model?: string
}
type RpcCommand = Record<string, unknown> & { type: string }
type RpcMessage = Record<string, unknown> & { type?: string; id?: string }
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type SocketData = { sessionId: string; unsubscribe?: () => void; history?: TranscriptMessage[]; leafId?: string | null; historyReady?: boolean; buffered?: RpcMessage[] }
type PendingPrompt = { content: string; metadata?: Record<string, unknown> }
type SseClient = { enqueue: (chunk: Uint8Array) => void; close: () => void }

const root = resolve(import.meta.dir, '..')
const webuiDir = import.meta.dir
const statePath = join(webuiDir, '.sessions.json')
const settingsPath = join(webuiDir, '.settings.json')
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

const DEFAULT_SETTINGS = {
  theme: 'dark', mode: 'build', autoScroll: true, expandDiffs: true,
  expandToolCalls: false, showReasoning: false, simpleChatMode: false,
  defaultModels: {}, hiddenSidebarAgents: ['auto', 'compaction', 'summary', 'title'],
  hiddenChatInputAgents: ['compaction', 'summary', 'title'], leaderKey: 'Cmd+O',
  directShortcuts: ['submit', 'abort'], keyboardShortcuts: {
    submit: 'Cmd+Enter', abort: 'Escape', toggleMode: 'T', undo: 'Z', redo: 'Shift+Z',
    compact: 'K', fork: 'F', settings: ',', sessions: 'S', newSession: 'N', closeSession: 'W',
    toggleSidebar: 'B', selectModel: 'M', variantCycle: 'Cmd+T',
  }, customCommands: [], gitCredentials: [], gitIdentity: { name: 'Pi Agent', email: '' },
  tts: { enabled: false }, stt: { enabled: false }, notifications: { enabled: false },
  integrations: [], repoSortMode: 'recent', serverEnvVars: [], disabledDefaultServerEnvVars: [],
}

type StoredSettings = Record<string, Record<string, unknown>>
function loadSettings(): StoredSettings {
  if (!existsSync(settingsPath)) return {}
  try { return object(JSON.parse(readFileSync(settingsPath, 'utf8'))) as StoredSettings } catch { return {} }
}
let userSettings = loadSettings()
function settingsFor(userId: string): Record<string, unknown> {
  return { ...DEFAULT_SETTINGS, ...(userSettings[userId] ?? {}) }
}
function saveSettings(): void {
  writeFileSync(settingsPath, `${JSON.stringify(userSettings, null, 2)}\n`, 'utf8')
}

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
const pendingPrompts = new Map<string, PendingPrompt>()
const sseClients = new Set<SseClient>()
const encoder = new TextEncoder()

function broadcastSse(value: unknown): void {
  const chunk = encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
  for (const client of sseClients) {
    try { client.enqueue(chunk) } catch { client.close(); sseClients.delete(client) }
  }
}

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

function nativeSessionsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR.replace(/^~/, homedir()))
    : join(homedir(), '.pi', 'agent')
  return process.env.PI_CODING_AGENT_SESSION_DIR
    ? resolve(process.env.PI_CODING_AGENT_SESSION_DIR.replace(/^~/, homedir()))
    : join(agentDir, 'sessions')
}

function entryTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function nativeSessionRecord(filePath: string, knownProjects: Project[]): SessionRecord | undefined {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n')
    const header = object(JSON.parse(lines[0] ?? ''))
    if (header.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') return undefined

    const project = knownProjects.find((item) => item.path === resolve(header.cwd as string))
    if (!project) return undefined

    const createdAt = entryTimestamp(header.timestamp, 0)
    let updatedAt = createdAt
    let title: string | undefined
    let firstMessage: string | undefined

    for (const line of lines) {
      if (!line.trim()) continue
      let entry: Record<string, unknown>
      try { entry = object(JSON.parse(line)) } catch { continue }
      updatedAt = Math.max(updatedAt, entryTimestamp(entry.timestamp, updatedAt))
      if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
        title = entry.name.trim()
      }
      if (entry.type === 'message' && !firstMessage) {
        const message = object(entry.message)
        if (message.role === 'user') {
          const text = sessionMessageText(message).replace(/\s+/g, ' ').trim()
          if (text) firstMessage = text.slice(0, 120)
        }
      }
    }

    return {
      id: header.id,
      project: project.name,
      title: title ?? firstMessage ?? 'Untitled session',
      createdAt,
      updatedAt,
    }
  } catch {
    return undefined
  }
}

function nativeSessionRecords(): SessionRecord[] {
  const directory = nativeSessionsDir()
  if (!existsSync(directory)) return []

  try {
    const knownProjects = projects()
    return readdirSync(directory, { withFileTypes: true }).flatMap((projectDirectory) => {
      if (!projectDirectory.isDirectory()) return []
      return readdirSync(join(directory, projectDirectory.name), { withFileTypes: true }).flatMap((file) => {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) return []
        const record = nativeSessionRecord(join(directory, projectDirectory.name, file.name), knownProjects)
        return record ? [record] : []
      })
    })
  } catch {
    return []
  }
}

function syncNativeSessions(): void {
  const current = new Map(sessions.map((session) => [session.id, session]))
  for (const native of nativeSessionRecords()) {
    const stored = current.get(native.id)
    if (!stored) {
      sessions.push(native)
      continue
    }
    if (stored.title === 'Untitled session' && native.title !== 'Untitled session') stored.title = native.title
    stored.createdAt = Math.min(stored.createdAt, native.createdAt)
    stored.updatedAt = Math.max(stored.updatedAt, native.updatedAt)
  }
}

function projectFor(name: string | undefined): Project {
  const value = projects().find((project) => project.name === name)
  if (!value) throw new Error(`Unknown project: ${name ?? ''}`)
  return value
}

function projectForDirectory(directory: string | undefined): Project {
  if (directory) {
    const value = projects().find((project) => project.path === resolve(directory))
    if (value) return value
  }
  return projects()[0]
}

function profilesForDirectory(directory: string | undefined): Record<string, unknown> {
  const project = projectForDirectory(directory)
  const files = [
    join(homedir(), '.pi', 'agent', 'agents.json'),
    join(project.path, '.pi', 'agents.json'),
  ]
  const profiles: Record<string, unknown> = {
    master: { systemPrompt: "Pi's normal runtime prompt", tools: [] },
  }

  for (const file of files) {
    if (!existsSync(file)) continue
    try { Object.assign(profiles, object(JSON.parse(readFileSync(file, 'utf8')))) } catch { continue }
  }

  return profiles
}

type SkillRecord = { name: string; description: string; body: string; scope: 'global' | 'project'; path: string; repoId?: number }

function skillDirectories(directory?: string): Array<{ scope: 'global' | 'project'; directory: string; repoId?: number }> {
  const result: Array<{ scope: 'global' | 'project'; directory: string; repoId?: number }> = []
  const projectDirectory = directory ? resolve(directory) : undefined
  if (projectDirectory) result.push({ scope: 'project', directory: join(projectDirectory, '.subpolar', 'skills') })
  else result.push({ scope: 'project', directory: join(root, '.subpolar', 'skills'), repoId: 1 })
  result.push({ scope: 'global', directory: join(homedir(), '.config', 'subpolar', 'skills') })
  result.push({ scope: 'global', directory: join(homedir(), '.pi', 'skills') })
  return result
}

function readSkills(directory?: string): SkillRecord[] {
  const result: SkillRecord[] = []
  for (const source of skillDirectories(directory)) {
    if (!existsSync(source.directory)) continue
    try {
      for (const entry of readdirSync(source.directory, { withFileTypes: true })) {
        const file = entry.isDirectory() ? join(source.directory, entry.name, 'SKILL.md') : entry.name === 'SKILL.md' ? join(source.directory, entry.name) : ''
        if (!file || !existsSync(file)) continue
        const content = readFileSync(file, 'utf8')
        const heading = content.match(/^#\s+(.+)$/m)
        const description = content.match(/^(?:description|summary):\s*(.+)$/im)?.[1]?.trim() ?? heading?.[1]?.trim() ?? ''
        const name = entry.isDirectory() ? entry.name : source.directory.split('/').pop() ?? 'skill'
        result.push({ name, description, body: content, scope: source.scope, path: file, repoId: source.repoId })
      }
    } catch { /* an unavailable skill directory should not break settings */ }
  }
  return [...new Map(result.map((skill) => [`${skill.scope}:${skill.repoId ?? ''}:${skill.name}`, skill])).values()]
}

function projectResponse(project: Project, id: number) {
  return {
    id,
    name: project.name,
    directory: project.path,
    fullPath: project.path,
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
  }
}

function projectResponses() {
  return [
    { id: 0, name: 'General Chat', directory: root, fullPath: root, status: 'ready', createdAt: 0, updatedAt: 0, isGeneralChat: true },
    ...projects().map((project, index) => projectResponse(project, index + 1)),
  ]
}

function storedSessionResponse(record: SessionRecord) {
  const project = projectFor(record.project)
  const projectId = Math.max(1, projects().findIndex((item) => item.name === project.name) + 1)
  return { ...record, projectId, directory: project.path }
}

function rpcData(value: unknown): unknown {
  const response = object(value)
  return response.data ?? value
}

function parseModelSelection(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const [providerID, ...rest] = model.split('/')
  const modelID = rest.join('/')
  return providerID && modelID ? { providerID, modelID } : undefined
}

async function transcriptHistory(sessionId: string, selection?: Pick<SessionRecord, 'profile' | 'model'>) {
  const payload = entriesPayload(await sendRpc(sessionId, { type: 'get_entries' }))
  return { ...payload, messages: projectEntries(payload.entries, payload.leafId, sessionId, selection) }
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
    if (record.model) args.push('--model', record.model)
    if (record.profile) args.push('--profile', record.profile)
    for (const extensionPath of extensionPaths) args.push('--extension', extensionPath)
    this.process = spawn('pi', args, { cwd: project.path, stdio: ['pipe', 'pipe', 'pipe'] })
    this.process.stdout.on('data', (chunk: Buffer) => this.read(chunk))
    this.process.stderr.on('data', () => undefined)
    this.process.on('close', () => {
      if (active.get(this.record.id) === this) active.delete(this.record.id)
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
    const transcript = new Set(['message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end'])
    const sessionID = typeof message.sessionID === 'string' ? message.sessionID : typeof message.sessionId === 'string' ? message.sessionId : undefined
    // Pi can settle the agent just before the final assistant message (and its
    // finish token) is delivered. Keep the sidebar busy until message_end.
    const assistantEvent = object(message.assistantMessageEvent ?? message)
    if (sessionID && (message.type === 'message_end' || assistantEvent.type === 'message_end')) {
      const inner = assistantEvent
      const assistant = object(inner.message ?? message.message)
      const content = Array.isArray(assistant.content) ? assistant.content : []
      const hasToolCall = content.some((part) => object(part).type === 'toolCall')
      if (!hasToolCall) {
        broadcastSse({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } })
      }
    }
    if (!transcript.has(String(message.type))) {
      const lifecycle = new Set(['agent_start', 'turn_start'])
      if (sessionID && lifecycle.has(String(message.type))) {
        broadcastSse({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } })
      } else if (message.type !== 'agent_settled') broadcastSse(message)
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
  syncNativeSessions()
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

async function runtimeProviders(): Promise<{ all: Record<string, unknown>[]; connected: string[]; default: Record<string, string> }> {
  const command = Bun.spawn(['pi', '--list-models'], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
  const output = await new Response(command.stdout).text()
  await command.exited

  const providers = new Map<string, Record<string, unknown>>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\S+)\s+(\S+)/)
    if (!match || match[1] === 'provider') continue

    const providerId = match[1]
    const modelId = match[2]
    const provider = providers.get(providerId) ?? {
      id: providerId,
      source: 'builtin',
      name: providerId,
      env: [],
      options: {},
      models: {},
    }
    const models = provider.models as Record<string, unknown>
    models[modelId] = {
      id: modelId,
      providerID: providerId,
      name: modelId,
      api: { id: modelId, npm: 'pi' },
      status: 'active',
      headers: {},
      options: {},
      cost: { input: 0, output: 0 },
      limit: { context: 0, output: 0 },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
      },
    }
    providers.set(providerId, provider)
  }

  return { all: [...providers.values()], connected: [...providers.keys()], default: {} }
}

const TRANSCRIPT_FRAME_LIMIT = 192 * 1024
const TRANSCRIPT_MESSAGE_LIMIT = 30

type TranscriptSocket = { data: SocketData; send: (value: string) => unknown; close: (code?: number, reason?: string) => void }

function sendHistoryChunk(socket: TranscriptSocket, mode: 'replace' | 'prepend', before?: string, limit = TRANSCRIPT_MESSAGE_LIMIT): void {
  const all = socket.data.history ?? []
  let end = before ? all.findIndex((message) => message.info.id === before) : all.length
  if (end < 0) end = all.length
  const selected: TranscriptMessage[] = []
  for (let index = end - 1; index >= 0 && selected.length < Math.max(1, limit); index--) {
    const candidate = all[index]
    const proposed = [candidate, ...selected]
    const frame = JSON.stringify({ type: 'history.chunk', mode, messages: proposed })
    if (selected.length > 0 && frame.length > TRANSCRIPT_FRAME_LIMIT) break
    selected.unshift(candidate)
  }
  const first = selected[0]
  const beforeId = first ? (all.findIndex((message) => message.info.id === first.info.id) > 0 ? all[all.findIndex((message) => message.info.id === first.info.id) - 1].info.id : undefined) : undefined
  socket.send(JSON.stringify({ type: 'history.chunk', mode, messages: selected, before: beforeId ?? null, hasMore: Boolean(beforeId), leafId: socket.data.leafId ?? null }))
}

async function loadSocketHistory(socket: TranscriptSocket, session: PiRpcSession, request: { type?: string; before?: string; limit?: number; leafId?: string }): Promise<void> {
  const payload = entriesPayload(await session.send({ type: 'get_entries' }))
  socket.data.history = projectEntries(payload.entries, payload.leafId, socket.data.sessionId, session.record)
  socket.data.leafId = payload.leafId
  socket.data.historyReady = true
  if (request.type === 'history.resume') socket.send(JSON.stringify({ type: 'history.reset' }))
  sendHistoryChunk(socket, request.type === 'history.load' && request.before ? 'prepend' : 'replace', request.before, request.limit)
  socket.send(JSON.stringify({ type: 'history.ready', leafId: payload.leafId }))
  for (const event of socket.data.buffered ?? []) {
    if (event.type !== 'response') socket.send(JSON.stringify({ type: 'transcript.event', event }))
  }
  socket.data.buffered = []
}

async function handleSocketMessage(socket: TranscriptSocket, raw: unknown, session: PiRpcSession): Promise<void> {
  try {
    const request = object(typeof raw === 'string' ? JSON.parse(raw) : raw)
    if (request.type === 'history.load' || request.type === 'history.resume') {
      if (!socket.data.historyReady || request.type === 'history.resume') {
        socket.data.historyReady = false
        await loadSocketHistory(socket, session, request as any)
      } else {
        sendHistoryChunk(socket, request.before ? 'prepend' : 'replace', typeof request.before === 'string' ? request.before : undefined, typeof request.limit === 'number' ? request.limit : undefined)
      }
    }
  } catch (error) {
    socket.send(JSON.stringify({ type: 'history.error', error: error instanceof Error ? error.message : String(error) }))
  }
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.split('/').filter(Boolean)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ status: 'healthy', timestamp: new Date().toISOString(), database: 'connected', runtime: 'pi', pi: 'healthy', activeSessions: active.size })
  if (request.method === 'GET' && url.pathname === '/api/projects') return json({ projects: projectResponses() })
  if (request.method === 'GET' && path[1] === 'projects' && path.length === 3) {
    const project = projectResponses().find((item) => item.id === Number(path[2]))
    return project ? json({ project }) : json({ error: 'Project not found' }, 404)
  }
  if (request.method === 'POST' && path[1] === 'projects' && path.length === 4 && path[3] === 'access') {
    // Compatibility heartbeat used by the project activity hook.
    return json({ ok: true })
  }
  if (request.method === 'GET' && url.pathname === '/api/agent') {
    const profiles = profilesForDirectory(url.searchParams.get('directory') ?? undefined)
    return json(Object.keys(profiles).map((name) => ({
      name,
      mode: 'primary',
      description: name === 'master' ? 'Pi default profile' : undefined,
    })))
  }
  if (request.method === 'GET' && url.pathname === '/api/provider') {
    try { return json(await runtimeProviders()) } catch { return json({ all: [], connected: [], default: {} }) }
  }
  if (request.method === 'GET' && url.pathname === '/api/config') return json({ model: undefined, default_agent: 'master', default_permission: 'ask' })
  if (request.method === 'GET' && url.pathname === '/api/command') return json([])
  if (request.method === 'GET' && url.pathname === '/api/sessions/status') {
    syncNativeSessions()
    return json(Object.fromEntries(sessions.map((session) => [session.id, { type: 'idle' }])))
  }
  if (request.method === 'GET' && url.pathname === '/api/sse/stream') {
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const client: SseClient = {
          enqueue: (chunk) => controller.enqueue(chunk),
          close: () => controller.close(),
        }
        sseClients.add(client)
        controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ clientId: 'pi-local', connected: active.size, total: active.size })}\n\n`))
        heartbeat = setInterval(() => controller.enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n')), 30000)
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat)
      },
    })
    return new Response(stream, { headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream', 'connection': 'keep-alive' } })
  }
  if (request.method === 'POST' && (url.pathname === '/api/sse/subscribe' || url.pathname === '/api/sse/unsubscribe' || url.pathname === '/api/sse/visibility')) return json({ ok: true })

  if (path[0] !== 'api') return json({ error: 'Not found' }, 404)

  // Settings are intentionally served by the local bridge as well as the full
  // server.  Keeping these routes here prevents a Vite/bridge-only install
  // from turning the settings page into a stream of 404s.
  if (path[1] === 'settings' && path.length === 2 && request.method === 'GET') {
    const userId = url.searchParams.get('userId') ?? 'default'
    return json({ preferences: settingsFor(userId), updatedAt: Date.now() })
  }
  if (path[1] === 'settings' && path.length === 2 && request.method === 'PATCH') {
    const userId = url.searchParams.get('userId') ?? 'default'
    const input = await body(request)
    const preferences = object(input.preferences)
    userSettings[userId] = { ...settingsFor(userId), ...preferences }
    saveSettings()
    return json({ preferences: settingsFor(userId), updatedAt: Date.now() })
  }
  if (path[1] === 'settings' && path.length === 2 && request.method === 'DELETE') {
    const userId = url.searchParams.get('userId') ?? 'default'
    delete userSettings[userId]
    saveSettings()
    return json({ preferences: settingsFor(userId), updatedAt: Date.now() })
  }
  if (path[1] === 'settings' && path[2] === 'pi-settings' && request.method === 'GET') {
    // Pi's native config is not required for the bridge to operate. Return a
    // valid empty collection until a config is created by the UI.
    return json({ configs: [], defaultConfig: null })
  }
  if (path[1] === 'settings' && path[2] === 'extensions' && request.method === 'GET') {
    const extensions = extensionPaths.filter(existsSync).map((file) => ({ name: file.split('/').pop()?.replace(/\.[^.]+$/, '') ?? file, path: file, source: 'builtin' as const }))
    const directories = [
      { directory: join(homedir(), '.pi', 'agent', 'extensions'), source: 'global' as const },
      { directory: join(root, '.pi', 'extensions'), source: 'project' as const },
    ]
    for (const source of directories) {
      if (!existsSync(source.directory)) continue
      try {
        for (const entry of readdirSync(source.directory, { withFileTypes: true })) {
          extensions.push({ name: entry.name.replace(/\.[^.]+$/, ''), path: join(source.directory, entry.name), source: source.source })
        }
      } catch { /* ignore unreadable extension directories */ }
    }
    return json({ extensions })
  }
  if (path[1] === 'settings' && path[2] === 'skills' && request.method === 'GET') {
    const directory = url.searchParams.get('directory') ?? undefined
    const repoId = url.searchParams.get('repoId')
    const skills = readSkills(directory).filter((skill) => !repoId || String(skill.repoId ?? '') === repoId)
    return json(skills)
  }
  if (path[1] === 'settings' && path[2] === 'skills' && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) return json({ error: 'Valid skill name is required' }, 400)
    const scope = input.scope === 'project' ? 'project' : 'global'
    const base = scope === 'project' ? join(projectForDirectory(typeof input.directory === 'string' ? input.directory : undefined).path, '.subpolar', 'skills') : join(homedir(), '.config', 'subpolar', 'skills')
    const file = join(base, input.name, 'SKILL.md')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `# ${input.name}\n\n${typeof input.description === 'string' ? input.description : ''}\n\n${typeof input.body === 'string' ? input.body : ''}\n`, 'utf8')
    return json(readSkills(scope === 'project' ? dirname(dirname(file)) : undefined).find((skill) => skill.name === input.name) ?? { name: input.name, scope, body: input.body ?? '' }, 201)
  }

  if (path[1] === 'sessions' && path.length === 2 && request.method === 'GET') {
    syncNativeSessions()
    const project = url.searchParams.get('project')
    const directory = url.searchParams.get('directory')
    return json({ sessions: sessions
      .filter((session) => !project || session.project === project)
      .filter((session) => !directory || projectFor(session.project).path === resolve(directory))
      .map(storedSessionResponse)
      .sort((a, b) => b.updatedAt - a.updatedAt) })
  }

  if (path[1] === 'sessions' && path.length === 2 && request.method === 'POST') {
    const input = await body(request)
    const project = typeof input.project === 'string'
      ? projectFor(input.project)
      : projectForDirectory(typeof input.directory === 'string' ? input.directory : undefined)
    const now = Date.now()
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      project: project.name,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled session',
      createdAt: now,
      updatedAt: now,
      profile: typeof input.agent === 'string' && input.agent.trim() ? input.agent : undefined,
      model: typeof input.model === 'string' && input.model.trim() ? input.model : undefined,
    }
    sessions.push(record)
    await saveState()
    rpcSession(record.id)
    return json({ session: storedSessionResponse(record) }, 201)
  }

  if (path[1] === 'sessions' && path.length >= 3) {
    const id = decodeURIComponent(path[2] ?? '')
    try {
      recordFor(id)
      if (path.length === 3 && request.method === 'GET') return json(storedSessionResponse(recordFor(id)))
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
      if (path.length === 4 && path[3] === 'messages' && request.method === 'GET') {
        const record = recordFor(id)
        const history = await transcriptHistory(id, record)
        return json({ messages: history.messages })
      }
      if (path.length === 5 && path[3] === 'tool-calls' && request.method === 'GET') {
        const callID = decodeURIComponent(path[4] ?? '')
        const payload = entriesPayload(await sendRpc(id, { type: 'get_entries' }))
        for (const entry of payload.entries) {
          const message = object(object(entry).message)
          if (message.role === 'toolResult' && message.toolCallId === callID) {
            return json({ callID, tool: message.toolName ?? null, input: object(message.input), output: sessionMessageText(message), details: object(message.details), error: message.isError ? sessionMessageText(message) : null })
          }
        }
        return json({ callID, output: '', details: {}, error: null }, 404)
      }
      if (path.length === 4 && path[3] === 'messages' && request.method === 'POST') {
        const input = await body(request)
        const metadata = object(input.metadata)
        const record = recordFor(id)
        const agent = typeof metadata.agent === 'string' && metadata.agent.trim() ? metadata.agent : 'master'
        const model = object(metadata.model)
        record.profile = agent
        if (typeof model.providerID === 'string' && typeof model.modelID === 'string') {
          record.model = `${model.providerID}/${model.modelID}`
        }
        await saveState()
        pendingPrompts.set(id, { content: typeof input.content === 'string' ? input.content : '', metadata })
        return json({ ok: true }, 201)
      }
      if (path.length === 4 && path[3] === 'runs' && request.method === 'POST') {
        const prompt = pendingPrompts.get(id)
        pendingPrompts.delete(id)
        if (!prompt?.content.trim()) return json({ error: 'Prompt content is required' }, 400)
        const metadata = prompt.metadata ?? {}
        const model = object(metadata.model)
        if (typeof model.providerID === 'string' && typeof model.modelID === 'string') {
          await sendRpc(id, { type: 'set_model', provider: model.providerID, modelId: model.modelID })
        }
        await sendRpc(id, { type: 'prompt', message: `/profile ${typeof metadata.agent === 'string' && metadata.agent.trim() ? metadata.agent : 'master'}` })
        return json(await sendRpc(id, { type: 'prompt', message: prompt.content }))
      }
      if (path.length === 4 && path[3] === 'state' && request.method === 'GET') return json(rpcData(await sendRpc(id, { type: 'get_state' })))
      if (path.length === 4 && path[3] === 'stats' && request.method === 'GET') return json(rpcData(await sendRpc(id, { type: 'get_session_stats' })))
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
    if (request.method === 'GET') return json({ projects: projectResponses() })
    if (request.method === 'POST') {
      const input = await body(request)
      if (typeof input.sessionId !== 'string' || typeof input.project !== 'string') return json({ error: 'sessionId and project are required' }, 400)
      projectFor(input.project)
      return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/project ${input.project}` }))
    }
  }

  if (path[1] === 'extensions' && (path[2] === 'profiles' || path[2] === 'agent-profiles') && request.method === 'GET') {
    const profiles = profilesForDirectory(url.searchParams.get('directory') ?? undefined)
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
        const payload = entriesPayload(response)
        const text = projectEntries(payload.entries, payload.leafId, record.id).map((item) => sessionMessageText(item.info)).join('\n')
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
        socket.data.buffered = []
        // Subscribe before reading entries. Events generated during the read are replayed
        // after the authoritative snapshot, so a reconnect cannot lose a turn.
        socket.data.unsubscribe = session.onMessage((message) => {
          if (!socket.data.historyReady) {
            if ((socket.data.buffered ?? []).length < 200) socket.data.buffered!.push(message)
            return
          }
          if (message.type !== 'response') socket.send(JSON.stringify({ type: 'transcript.event', event: message }))
        })
      } catch {
        socket.close(1011, 'Unknown session')
      }
    },
    close(socket) {
      socket.data.unsubscribe?.()
    },
    message(socket, raw) {
      void handleSocketMessage(socket, raw, rpcSession(socket.data.sessionId))
    },
  },
})
