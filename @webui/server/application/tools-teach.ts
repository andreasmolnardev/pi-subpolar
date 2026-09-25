import { spawn } from 'node:child_process'
import { createMcpAdapter, type McpServerConfig } from './mcp-adapter.ts'
import { redactSensitive, redactSensitiveText } from '../core/security-redaction.ts'
import { manageRegisteredTool } from './tools.ts'
import type PocketBase from 'pocketbase'

export type TeachKind = 'cli' | 'mcp' | 'openapi'
export type ToolDraft = {
  tool_id: string
  namespace: string
  description: string
  adapter: 'internal' | 'mcp' | 'openapi'
  target: string
  operation: string
  input_schema: Record<string, unknown>
  output_schema: Record<string, unknown>
  risk: 'read' | 'write' | 'delete' | 'external'
  requires_approval: boolean
  enabled: boolean
  context_mode: 'discoverable'
  metadata: Record<string, unknown>
}

const safeExecutables = new Set(['bun', 'cargo', 'git', 'go', 'node', 'npm', 'pnpm', 'pytest', 'python', 'python3', 'rustc'])
const safeHelpArgs = new Set(['--help', '-h', 'help', '--version', '-V', 'version', 'list', '--list', 'commands'])
const SECRET_KEY = /(?:authorization|api.?key|token|secret|password|credential|cookie)/i
const SAFE_TIMEOUT_MS = 5_000
const SAFE_OUTPUT_BYTES = 16_384

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid`)
  return value.trim()
}
function safeObject(value: unknown, label: string): Record<string, unknown> {
  const obj = record(value)
  if (!Object.keys(obj).length || JSON.stringify(obj).length > 200_000) throw new Error(`${label} must be a non-empty JSON object under 200KB`)
  return obj
}
function assertNoUrlSecrets(value: unknown, label: string): void {
  if (typeof value !== 'string') return
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${label} must be a valid URL`) }
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => SECRET_KEY.test(key))) throw new Error(`${label} must not contain credentials or secret query parameters`)
}
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(scrub)
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactSensitiveText(value).slice(0, 4000) : value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !SECRET_KEY.test(key)).slice(0, 100).map(([key, item]) => [key, scrub(item)]))
}
function makeId(value: string): string {
  const operation = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'proposal'
  return operation
}
function draftBase(input: { goal: string; namespace: string; name: string; description: string; adapter: ToolDraft['adapter']; target: string; operation: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; risk?: ToolDraft['risk']; metadata?: Record<string, unknown> }): ToolDraft {
  const namespace = input.namespace.toLowerCase()
  const operation = input.operation.toLowerCase()
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(namespace) || !/^[a-z][a-z0-9_-]{0,63}$/.test(operation)) throw new Error('Generated tool namespace or operation is invalid')
  return {
    tool_id: `${namespace}/${operation}`, namespace,
    description: redactSensitiveText(input.description).slice(0, 1000), adapter: input.adapter,
    target: input.target, operation, input_schema: input.inputSchema,
    output_schema: input.outputSchema ?? { type: 'object' }, risk: input.risk ?? 'read',
    requires_approval: input.risk !== undefined && input.risk !== 'read', enabled: false,
    context_mode: 'discoverable', metadata: scrub(input.metadata ?? {}) as Record<string, unknown>,
  }
}

export async function runSafeCliIntrospection(command: string, fixedArgs: string[] = [], cwd?: string): Promise<string> {
  const executable = boundedText(command, 200, 'CLI command')
  if (!safeExecutables.has(executable) || executable.includes('/') || executable.includes('\\')) throw new Error('CLI command must be a supported executable name')
  if (!Array.isArray(fixedArgs) || fixedArgs.length > 12 || fixedArgs.some((arg) => typeof arg !== 'string' || arg.length > 128 || !safeHelpArgs.has(arg))) throw new Error('CLI exploration accepts only allowlisted help and introspection arguments')
  let workingDirectory: string | undefined
  if (cwd !== undefined) {
    workingDirectory = boundedText(cwd, 1024, 'Working directory')
    if (!workingDirectory.startsWith('/')) throw new Error('Working directory must be absolute')
  }
  const args = fixedArgs.length ? fixedArgs : ['--help']
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, cwd: workingDirectory, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: SAFE_TIMEOUT_MS, windowsHide: true })
    let output = ''
    let byteCount = 0
    const capture = (chunk: Buffer) => {
      const remaining = SAFE_OUTPUT_BYTES - byteCount
      if (remaining <= 0) return
      const text = chunk.subarray(0, remaining).toString('utf8')
      output += text
      byteCount += Buffer.byteLength(text)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', () => reject(new Error('Could not run the selected CLI introspection command')))
    child.once('close', () => resolve(redactSensitiveText(output).slice(0, SAFE_OUTPUT_BYTES)))
  })
}

function openApiEntries(spec: Record<string, unknown>): Array<{ method: string; path: string; operation: Record<string, unknown>; pathItem: Record<string, unknown> }> {
  const paths = record(spec.paths)
  const entries: Array<{ method: string; path: string; operation: Record<string, unknown>; pathItem: Record<string, unknown> }> = []
  for (const [path, rawItem] of Object.entries(paths).slice(0, 200)) {
    const pathItem = record(rawItem)
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = record(pathItem[method])
      if (Object.keys(operation).length) entries.push({ method, path, operation, pathItem })
    }
  }
  return entries
}

function schemaForOpenApi(operation: Record<string, unknown>, pathItem: Record<string, unknown>): Record<string, unknown> {
  const parameters = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const raw of parameters.slice(0, 50)) {
    const parameter = record(raw)
    if (typeof parameter.name !== 'string' || SECRET_KEY.test(parameter.name)) continue
    const schema = record(parameter.schema)
    properties[parameter.name] = scrub(schema)
    if (parameter.required === true) required.push(parameter.name)
  }
  const requestBody = record(operation.requestBody)
  const content = record(requestBody.content)
  const jsonBody = record(content['application/json'])
  const bodySchema = record(jsonBody.schema)
  if (Object.keys(bodySchema).length) {
    properties.body = scrub(bodySchema)
    if (requestBody.required === true) required.push('body')
  }
  return { type: 'object', properties, ...(required.length ? { required: [...new Set(required)] } : {}), additionalProperties: false }
}

export type TeachDraftGenerator = (input: { goal: string; observations: string[]; drafts: ToolDraft[] }) => Promise<{ drafts: Array<Pick<ToolDraft, 'tool_id' | 'description'> & { fixedArgs?: string[]; maxArgs?: number }> }>

export async function proposeTools(input: unknown, generateDrafts?: TeachDraftGenerator): Promise<{ observations: string[]; drafts: ToolDraft[] }> {
  const args = record(input)
  if (!['cli', 'mcp', 'openapi'].includes(String(args.kind))) throw new Error('kind must be cli, mcp, or openapi')
  const kind = args.kind as TeachKind
  const goal = boundedText(args.goal, 2000, 'Goal')
  const observations = ['Source exploration is bounded and read-only; no tool operation was invoked.', 'Drafts remain disabled and unregistered until explicitly confirmed.']
  const drafts: ToolDraft[] = []
  if (kind === 'cli') {
    if (typeof args.command !== 'string') throw new Error('CLI command is required')
    const text = await runSafeCliIntrospection(args.command, Array.isArray(args.fixedArgs) ? args.fixedArgs as string[] : [], typeof args.cwd === 'string' ? args.cwd : undefined)
    observations.push(text ? `Bounded help output from ${args.command}: ${text.slice(0, 3000)}` : `Ran safe help introspection for ${args.command}; no output was returned.`)
    const namespace = makeId(args.command)
    const operation = makeId(goal)
    const fixedArgs: string[] = []
    drafts.push(draftBase({ goal, namespace, name: operation, description: `Run ${args.command} for: ${goal}`, adapter: 'internal', target: 'cli', operation: 'run', inputSchema: { type: 'object', properties: { args: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 256 } } }, required: ['args'], additionalProperties: false }, risk: 'external', metadata: { cli: { executable: args.command, fixedArgs, maxArgs: 12, timeoutMs: SAFE_TIMEOUT_MS, maxOutputBytes: SAFE_OUTPUT_BYTES } } }))
    // This draft targets the existing constrained CLI registration path, which uses the tool ID as its operation.
    drafts[0].tool_id = `${namespace}/${operation}`
    drafts[0].operation = 'run'
    drafts[0].input_schema = { type: 'object', properties: { args: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 256 } } }, required: ['args'], additionalProperties: false }
    drafts[0].metadata = { cli: { executable: args.command, fixedArgs, maxArgs: 12, timeoutMs: SAFE_TIMEOUT_MS, maxOutputBytes: SAFE_OUTPUT_BYTES } }
  } else if (kind === 'mcp') {
    const server = safeObject(args.server, 'MCP server') as unknown as McpServerConfig
    if (!['stdio', 'http', 'sse'].includes(server.transport)) throw new Error('MCP transport is invalid')
    if (server.transport !== 'stdio') assertNoUrlSecrets(server.url, 'MCP URL')
    if (server.env && Object.values(server.env).some((v) => typeof v === 'string' && v.length > 0)) throw new Error('MCP environment values must use environment references; inline secrets are not accepted')
    if (server.headers && Object.values(server.headers).some((v) => typeof v === 'string' && v.length > 0)) throw new Error('MCP headers must use environment references; inline secrets are not accepted')
    const adapter = createMcpAdapter({ limits: { requestTimeoutMs: SAFE_TIMEOUT_MS, maxRequestTimeoutMs: SAFE_TIMEOUT_MS, maxTools: 100, maxListPages: 5, maxResponseBytes: 256_000 } })
    try {
      const tools = await adapter.discover({ ...server, timeoutMs: SAFE_TIMEOUT_MS })
      observations.push(`MCP tools/list returned ${tools.length} tool definition(s); no operation was invoked.`)
      const selected = tools.filter((tool) => goal.toLowerCase().includes(tool.name.toLowerCase()) || tools.length === 1).slice(0, 10)
      for (const tool of (selected.length ? selected : tools).slice(0, 100)) drafts.push(draftBase({ goal, namespace: tool.namespace ?? server.namespace ?? 'mcp', name: tool.name, description: redactSensitiveText(tool.description || goal), adapter: 'mcp', target: server.transport === 'stdio' ? server.command ?? '' : server.url ?? '', operation: tool.name, inputSchema: record(scrub(tool.inputSchema)), outputSchema: record(scrub(tool.outputSchema ?? {})), risk: 'external', metadata: { mcp: scrub({ ...server, namespace: tool.namespace ?? server.namespace ?? 'mcp' }) as Record<string, unknown> } }))
    } finally { await adapter.close() }
  } else {
    const config = safeObject(args.openapi, 'OpenAPI configuration')
    const spec = safeObject(config.spec, 'OpenAPI spec')
    if (typeof spec.openapi !== 'string' && typeof spec.swagger !== 'string') throw new Error('OpenAPI spec must declare openapi or swagger')
    const target = boundedText(config.url, 2048, 'OpenAPI URL')
    const parsedUrl = new URL(target)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('OpenAPI URL must be HTTP(S)')
    assertNoUrlSecrets(target, 'OpenAPI URL')
    const entries = openApiEntries(spec)
    if (!entries.length) throw new Error('OpenAPI document contains no supported operations')
    observations.push(`Inspected ${entries.length} operation schema(s) from the supplied OpenAPI document; no request was sent.`)
    const selected = entries.filter((entry) => `${entry.method} ${entry.path} ${String(entry.operation.summary ?? '')}`.toLowerCase().includes(goal.toLowerCase())).slice(0, 5)
    for (const entry of (selected.length ? selected : entries).slice(0, 100)) {
      const tag = Array.isArray(entry.operation.tags) && typeof entry.operation.tags[0] === 'string' ? entry.operation.tags[0] : 'openapi'
      const op = typeof entry.operation.operationId === 'string' ? entry.operation.operationId : `${entry.method}_${entry.path}`
      const operation = makeId(op)
      drafts.push(draftBase({ goal, namespace: makeId(tag), name: operation, description: redactSensitiveText(String(entry.operation.summary ?? entry.operation.description ?? `${entry.method.toUpperCase()} ${entry.path}`)), adapter: 'openapi', target, operation, inputSchema: schemaForOpenApi(entry.operation, entry.pathItem), outputSchema: record(scrub(record(record(entry.operation.responses)['200']).content && record(record(record(record(entry.operation.responses)['200']).content)['application/json']).schema)), risk: entry.method === 'get' ? 'read' : 'write', metadata: { url: target.replace(/\/$/, '') + entry.path, method: entry.method.toUpperCase(), path: entry.path, parameters: [...(Array.isArray(entry.pathItem.parameters) ? entry.pathItem.parameters : []), ...(Array.isArray(entry.operation.parameters) ? entry.operation.parameters : [])].map((parameter) => { const value = record(parameter); return { name: value.name, in: value.in, required: value.required === true } }).filter((parameter) => typeof parameter.name === 'string' && !SECRET_KEY.test(parameter.name) && ['path', 'query', 'header'].includes(String(parameter.in))), requestBody: Object.keys(record(entry.operation.requestBody)).length > 0 } }))
    }
  }
  const safeObservations = observations.map((item) => redactSensitiveText(item).slice(0, 4000))
  let selectedDrafts = drafts
  if (generateDrafts && drafts.length) {
    const generated = await generateDrafts({ goal, observations: safeObservations, drafts: drafts.map((draft) => redactSensitive(draft) as ToolDraft) })
    const byId = new Map(drafts.map((draft) => [draft.tool_id, draft]))
    const seen = new Set<string>()
    selectedDrafts = generated.drafts.slice(0, 20).map((proposal) => {
      const original = byId.get(proposal.tool_id)
      if (!original || seen.has(proposal.tool_id)) throw new Error('Teach model returned an unknown or duplicate tool draft')
      seen.add(proposal.tool_id)
      const updated = { ...original, description: redactSensitiveText(boundedText(proposal.description, 1000, 'Generated description')).slice(0, 1000) }
      if (original.adapter === 'internal' && original.target === 'cli') {
        const cli = record(record(original.metadata).cli)
        if (proposal.fixedArgs !== undefined) {
          if (!Array.isArray(proposal.fixedArgs) || proposal.fixedArgs.length > 32 || proposal.fixedArgs.some((arg) => typeof arg !== 'string' || arg.length > 256 || /[\0\r\n]/.test(arg))) throw new Error('Teach model returned invalid CLI command arguments')
          cli.fixedArgs = proposal.fixedArgs
        }
        if (proposal.maxArgs !== undefined) {
          if (!Number.isInteger(proposal.maxArgs) || proposal.maxArgs < 0 || proposal.maxArgs > 12) throw new Error('Teach model returned an invalid CLI argument limit')
          cli.maxArgs = proposal.maxArgs
          record(updated.input_schema).properties = { args: { type: 'array', maxItems: proposal.maxArgs, items: { type: 'string', maxLength: 256 } } }
        }
        updated.metadata = { cli }
      }
      return updated
    })
    if (!selectedDrafts.length) throw new Error('Teach model did not select any valid tool drafts')
  }
  return { observations: safeObservations, drafts: selectedDrafts.map((draft) => redactSensitive(draft) as ToolDraft) }
}

export async function registerToolDraft(client: PocketBase, userId: string, input: unknown): Promise<unknown> {
  const draft = record(input)
  const adapter = draft.adapter
  if (!['internal', 'mcp', 'openapi'].includes(String(adapter))) throw new Error('Unsupported draft adapter')
  if (adapter === 'internal') {
    if (draft.target !== 'cli' || draft.operation !== 'run') throw new Error('Only constrained CLI drafts may use the internal adapter')
    const metadata = record(draft.metadata)
    const cli = record(metadata.cli)
    return manageRegisteredTool(client, 'create-cli', {
      tool_id: draft.tool_id, namespace: draft.namespace, description: draft.description,
      executable: cli.executable, fixed_args: cli.fixedArgs, max_args: cli.maxArgs,
      timeout_ms: cli.timeoutMs, max_output_bytes: cli.maxOutputBytes,
    }, userId)
  }
  return manageRegisteredTool(client, 'create', {
    tool_id: draft.tool_id, namespace: draft.namespace, description: draft.description,
    adapter, target: draft.target, operation: draft.operation,
    input_schema: draft.input_schema, output_schema: draft.output_schema,
    risk: draft.risk, requires_approval: draft.requires_approval === true,
    enabled: true, context_mode: draft.context_mode,
    metadata: draft.metadata,
  }, userId)
}
