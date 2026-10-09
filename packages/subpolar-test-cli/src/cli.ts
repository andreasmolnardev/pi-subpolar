#!/usr/bin/env bun
import { SubpolarApiError, SubpolarClient } from '@subpolar/client'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type CliClient = SubpolarClient

const DEFAULT_URL = 'http://localhost:4173'
const USAGE = `Usage: subpolar-test-cli [global options] <command>
Global options: --url URL | --env NAME | --profile NAME, --token USER_TOKEN, --timeout MS, --json
Commands:
  status
  agents list | agents inspect <ID> | agents create <NAME> [--description TEXT] [--prompt TEXT] [--system-prompt TEXT] [--model PROVIDER/MODEL] [--thinking LEVEL] [--template NAME] [--mode primary|subagent] [--config JSON] | agents update <ID> [profile options] | agents delete <ID>
  models list
  projects list | create <NAME> [--directory PATH] [--agents NAME,...] | update <ID> [--name NAME] [--directory PATH] [--agents NAME,...] | delete <ID>
  sessions list [--project ID] [--search TEXT]
  sessions create [--title TEXT] [--project ID] [--repository ID] [--directory PATH] [--agent NAME] [--model ID] [--thinking LEVEL] [--permission MODE] [--worktree ID]
  sessions send <SESSION_ID> <MESSAGE> [--model PROVIDER/MODEL] [--follow]
  sessions inspect <SESSION_ID> | messages <SESSION_ID> | events <SESSION_ID> [--after ID] [--limit N] | tool-call <SESSION_ID> <CALL_ID>
  sessions errors <SESSION_ID> | update <SESSION_ID> [--title TEXT] [--archived true|false] [--model PROVIDER/MODEL] | delete <SESSION_ID> | abort <SESSION_ID>
  runs inspect <RUN_ID>
  tools list [--agent ID] | tools policies set <AGENT_ID> --policy TOOL_ID=allow|deny|approval [...]
  worktrees create <PROJECT_ID> --branch NAME --source-ref REF --expected-sha SHA
  repository status <PROJECT_ID>
  approvals list | approvals inspect <ID> | approvals decision <ID> --session ID --response approve|reject|once|always
  settings inspect | settings update --key VALUE [--key VALUE ...]`

export interface CliIo { stdout?: (text: string) => void; stderr?: (text: string) => void }
export interface CliOptions { fetch?: FetchLike; io?: CliIo; token?: string; baseUrl?: string; client?: SubpolarClient }
export class CliUsageError extends Error {}
class UnsupportedCommandError extends Error {}
class CliRuntimeResultError extends Error {
  constructor(readonly code: string, message: string, readonly state?: string, readonly recoverable?: boolean) {
    super(message)
  }
}

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new CliUsageError(`${option} requires a value`)
  return value
}
function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option)
  return index < 0 ? undefined : valueAfter(args, index, option)
}
function required(value: string | undefined, label: string): string {
  if (!value || value.startsWith('--')) throw new CliUsageError(`Missing ${label}`)
  return value
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function runtimeResultError(value: unknown): CliRuntimeResultError | undefined {
  if (!isRecord(value)) return undefined
  const state = typeof value.state === 'string' ? value.state : undefined
  if (value.ok !== false && !['interrupted', 'failed', 'unknown'].includes(state ?? '')) return undefined
  const details = isRecord(value.error) ? value.error : undefined
  const code = typeof details?.code === 'string'
    ? details.code
    : state ? `RUN_${state.toUpperCase()}` : 'RUN_FAILED'
  const message = typeof details?.message === 'string'
    ? details.message
    : state ? `Run ${state}` : 'Run failed'
  return new CliRuntimeResultError(code, message, state, typeof value.recoverable === 'boolean' ? value.recoverable : undefined)
}
function parseScalar(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}
function human(value: unknown): string {
  if (value === undefined || value === null) return '(none)\n'
  if (Array.isArray(value)) return value.length ? value.map((item) => `- ${human(item).trim()}`).join('\n') + '\n' : '(none)\n'
  return typeof value === 'object' ? `${JSON.stringify(value, null, 2)}\n` : `${String(value)}\n`
}
function unsupported(message: string): never { throw new UnsupportedCommandError(message) }
function parseModelSelection(value: string): { providerID: string; modelID: string } {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) throw new CliUsageError('--model must use PROVIDER/MODEL format')
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.io?.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = options.io?.stderr ?? ((text: string) => process.stderr.write(text))
  let json = false
  let timedOut = false
  let command = 'unknown'
  let requestId = `subpolar-cli-${crypto.randomUUID()}`
  try {
    const args: string[] = []
    let url: string | undefined
    let env: string | undefined
    let profile: string | undefined
    let token: string | undefined
    let timeout = 30_000
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!
      if (arg === '--') { args.push(...argv.slice(i)); break }
      if (arg === '--url') url = valueAfter(argv, i++, arg)
      else if (arg === '--env') env = valueAfter(argv, i++, arg)
      else if (arg === '--profile') profile = valueAfter(argv, i++, arg)
      else if (arg === '--token') token = valueAfter(argv, i++, arg)
      else if (arg === '--timeout') {
        timeout = Number(valueAfter(argv, i++, arg))
        if (!Number.isSafeInteger(timeout) || timeout < 1) throw new CliUsageError('--timeout must be a positive integer in milliseconds')
      } else if (arg === '--json') json = true
      else args.push(arg)
    }
    if (env && profile) throw new CliUsageError('--env and --profile cannot be combined')
    const selector = profile ? `PROFILE_${profile.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` : env ? `ENV_${env.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` : undefined
    const baseUrl = options.baseUrl ?? url ?? (selector ? process.env[`SUBPOLAR_${selector}_URL`] : undefined) ?? process.env.SUBPOLAR_URL ?? DEFAULT_URL
    const userToken = options.token ?? token ?? (selector ? process.env[`SUBPOLAR_${selector}_TOKEN`] : undefined) ?? process.env.SUBPOLAR_TOKEN
    const controller = new AbortController()
    const transport: FetchLike = async (input, init = {}) => {
      const headers = new Headers(init.headers)
      headers.set('x-request-id', requestId)
      const requestController = new AbortController()
      const requestTimer = setTimeout(() => { timedOut = true; requestController.abort(new Error('Request timed out')) }, timeout)
      const signal = init.signal ? AbortSignal.any([init.signal, requestController.signal]) : requestController.signal
      try {
        return await (options.fetch ?? fetch)(input, { ...init, headers, signal })
      } finally {
        clearTimeout(requestTimer)
      }
    }
    const client = (options.client ?? new SubpolarClient({ baseUrl, token: userToken, fetch: transport })) as CliClient
    const [group, action, ...rest] = args
    command = [group, action].filter(Boolean).join(' ') || 'unknown'
    if (!group) throw new CliUsageError(USAGE)
    let data: unknown
    let streamed = false

    if (group === 'status' && action === undefined) data = { health: await client.health(), capabilities: await client.capabilities(), baseUrl, requestId }
    else if (group === 'agents' && action === 'list') data = await client.listAgents()
    else if (group === 'agents' && action === 'inspect') {
      const id = required(rest[0], 'AGENT_ID')
      const agents = await client.listAgents()
      data = agents.find((agent) => agent.id === id || agent.name === id)
      if (!data) throw new CliUsageError(`Agent not found: ${id}`)
    } else if (group === 'agents' && (action === 'create' || action === 'update')) {
      const idOrName = required(rest[0], action === 'create' ? 'AGENT_NAME' : 'AGENT_ID')
      const configText = optionValue(rest, '--config')
      let input: Record<string, unknown> = {}
      if (configText) {
        try {
          const parsed: unknown = JSON.parse(configText)
          if (!isRecord(parsed)) throw new Error('expected an object')
          input = parsed
        } catch (error) {
          throw new CliUsageError(`--config must be a JSON object: ${error instanceof Error ? error.message : 'invalid JSON'}`)
        }
      }
      const fields: Array<[string, string]> = [
        ['--description', 'description'], ['--prompt', 'prompt'], ['--system-prompt', 'systemPrompt'],
        ['--model', 'model'], ['--thinking', 'thinking'], ['--template', 'template'], ['--mode', 'mode'],
        ['--approval-mode', 'approval_mode'],
      ]
      for (const [flag, key] of fields) {
        const value = optionValue(rest, flag)
        if (value !== undefined) input[key] = value
      }
      const enabled = optionValue(rest, '--enabled')
      if (enabled !== undefined) {
        if (!['true', 'false'].includes(enabled)) throw new CliUsageError('--enabled must be true or false')
        input.enabled = enabled === 'true'
      }
      if (action === 'create') input.name = idOrName
      if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.includes('/'))) {
        throw new CliUsageError('--model must use PROVIDER/MODEL format')
      }
      if (input.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high'].includes(String(input.thinking))) throw new CliUsageError('--thinking must be off, minimal, low, medium, or high')
      if (input.mode !== undefined && !['primary', 'subagent'].includes(String(input.mode))) throw new CliUsageError('--mode must be primary or subagent')
      if (action === 'create') data = await client.createAgent(input)
      else data = await client.updateAgent(idOrName, input)
    } else if (group === 'agents' && action === 'delete') data = await client.deleteAgent(required(rest[0], 'AGENT_ID'))
    else if (group === 'models' && action === 'list') data = await client.listModels()
    else if (group === 'projects' && action === 'list') data = await client.listProjects()
    else if (group === 'projects' && action === 'create') {
      const name = required(rest[0], 'PROJECT_NAME')
      const directory = optionValue(rest, '--directory'); const agents = optionValue(rest, '--agents')
      data = await client.createProject({ name, ...(directory ? { directory } : {}), ...(agents ? { agentNames: agents.split(',').map((value) => value.trim()).filter(Boolean) } : {}) })
    } else if (group === 'projects' && action === 'update') {
      const id = Number(required(rest[0], 'PROJECT_ID'))
      if (!Number.isSafeInteger(id) || id < 0) throw new CliUsageError('PROJECT_ID must be a non-negative integer')
      const name = optionValue(rest, '--name'); const directory = optionValue(rest, '--directory'); const agents = optionValue(rest, '--agents')
      if (!name && !directory && agents === undefined) throw new CliUsageError('projects update requires --name, --directory, or --agents')
      data = await client.updateProject(id, { ...(name ? { name } : {}), ...(directory ? { directory } : {}), ...(agents === undefined ? {} : { agentNames: agents.split(',').map((value) => value.trim()).filter(Boolean) }) })
    } else if (group === 'projects' && action === 'delete') {
      const id = Number(required(rest[0], 'PROJECT_ID'))
      if (!Number.isSafeInteger(id) || id < 0) throw new CliUsageError('PROJECT_ID must be a non-negative integer')
      data = await client.deleteProject(id)
    } else if (group === 'sessions' && action === 'list') {
      const project = optionValue(rest, '--project'); const search = optionValue(rest, '--search')
      data = await client.listSessions({ ...(project ? { project } : {}), ...(search ? { search } : {}) })
    } else if (group === 'sessions' && action === 'create') {
      const title = optionValue(rest, '--title'); const project = optionValue(rest, '--project'); const repositoryId = optionValue(rest, '--repository'); const directory = optionValue(rest, '--directory')
      const agent = optionValue(rest, '--agent'); const model = optionValue(rest, '--model'); const thinking = optionValue(rest, '--thinking')
      const permission = optionValue(rest, '--permission'); const worktreeId = optionValue(rest, '--worktree')
      if (thinking && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking)) throw new CliUsageError('--thinking must be off, minimal, low, medium, high, or xhigh')
      if (permission && !['ask', 'none', 'allow_all'].includes(permission)) throw new CliUsageError('--permission must be ask, none, or allow_all')
      data = await client.createSession({ ...(title ? { title } : {}), ...(project ? { project } : {}), ...(repositoryId ? { repositoryId } : {}), ...(directory ? { directory } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking: thinking as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' } : {}), ...(permission ? { permission: permission as 'ask' | 'none' | 'allow_all' } : {}), ...(worktreeId ? { worktreeId } : {}) })
    } else if (group === 'sessions' && action === 'send') {
      const sessionId = required(rest[0], 'SESSION_ID')
      const follow = rest.includes('--follow')
      const model = optionValue(rest, '--model')
      const limit = Number(optionValue(rest, '--limit') ?? '0')
      if (!Number.isSafeInteger(limit) || limit < 0) throw new CliUsageError('--limit must be a non-negative integer')
      const message: string[] = []
      for (let i = 1; i < rest.length; i++) {
        const arg = rest[i]!
        if (arg === '--') { message.push(...rest.slice(i + 1)); break }
        if (arg === '--follow') continue
        if (['--limit', '--model'].includes(arg)) { valueAfter(rest, i++, arg); continue }
        message.push(arg)
      }
      if (!message.length) throw new CliUsageError('sessions send requires <SESSION_ID> <MESSAGE>')
      const modelSelection = model ? parseModelSelection(model) : undefined
      const metadata = { requestId, ...(modelSelection ? { model: modelSelection } : {}) }
      let eventPump: Promise<void> | undefined
      if (follow) {
        streamed = true
        eventPump = (async () => {
          let count = 0
          try {
            for await (const event of client.events({ sessionId, signal: controller.signal })) {
              count++
              if (json) stdout(`${JSON.stringify({ event: 'stream', type: event.event ?? 'message', id: event.id, data: event.data })}\n`)
              else stdout(`${event.event ?? 'message'}${event.id ? ` [${event.id}]` : ''}: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}\n`)
              if (limit && count >= limit) break
            }
          } catch (error) {
            if (!controller.signal.aborted) throw error
          }
        })()
      }
      try {
        data = await client.run(sessionId, message.join(' '), { messageID: requestId, metadata })
      } finally {
        if (follow) controller.abort()
        await eventPump?.catch((error: unknown) => { if (!controller.signal.aborted) throw error })
      }
      const runtimeError = runtimeResultError(data)
      if (runtimeError) throw runtimeError
    } else if (group === 'sessions' && action === 'inspect') {
      const id = required(rest[0], 'SESSION_ID')
      data = { session: await client.getSession(id), messages: await client.messages(id) }
    } else if (group === 'sessions' && action === 'messages') data = await client.messages(required(rest[0], 'SESSION_ID'))
    else if (group === 'sessions' && action === 'tool-call') {
      data = await client.inspectToolCall(required(rest[0], 'SESSION_ID'), required(rest[1], 'CALL_ID'))
    } else if (group === 'sessions' && action === 'errors') {
      const messages = await client.messages(required(rest[0], 'SESSION_ID'))
      data = messages.filter((item) => isRecord(item) && ('error' in item || item.type === 'error'))
    } else if (group === 'sessions' && action === 'events') {
      const sessionId = required(rest[0], 'SESSION_ID'); const after = optionValue(rest, '--after'); const limit = Number(optionValue(rest, '--limit') ?? '0')
      if (!Number.isSafeInteger(limit) || limit < 0) throw new CliUsageError('--limit must be a non-negative integer')
      const events: unknown[] = []; streamed = true
      for await (const event of client.events({ sessionId, ...(after ? { after } : {}), signal: controller.signal })) {
        events.push(event)
        if (json) stdout(`${JSON.stringify({ event: 'stream', type: event.event ?? 'message', id: event.id, data: event.data })}\n`)
        else stdout(`${event.event ?? 'message'}${event.id ? ` [${event.id}]` : ''}: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}\n`)
        if (limit && events.length >= limit) break
      }
      data = { received: events.length }
    } else if (group === 'sessions' && action === 'update') {
      const id = required(rest[0], 'SESSION_ID'); const title = optionValue(rest, '--title'); const archivedValue = optionValue(rest, '--archived'); const model = optionValue(rest, '--model')
      if (!title && archivedValue === undefined && model === undefined) throw new CliUsageError('sessions update requires --title, --archived, or --model')
      if (archivedValue !== undefined && archivedValue !== 'true' && archivedValue !== 'false') throw new CliUsageError('--archived must be true or false')
      if (model !== undefined) parseModelSelection(model)
      data = await client.updateSession(id, { ...(title ? { title } : {}), ...(archivedValue === undefined ? {} : { archived: archivedValue === 'true' }), ...(model ? { model } : {}) })
    } else if (group === 'sessions' && action === 'delete') data = await client.deleteSession(required(rest[0], 'SESSION_ID'))
    else if (group === 'sessions' && action === 'abort') data = await client.abortRun(required(rest[0], 'SESSION_ID'))
    else if (group === 'runs' && action === 'inspect') data = await client.inspectRun(required(rest[0], 'RUN_ID'))
    else if (group === 'tools' && action === 'list') {
      const agentId = optionValue(rest, '--agent')
      const tools = await client.listTools()
      data = agentId ? { tools, policies: await client.listAgentToolPolicies(agentId) } : tools
    } else if (group === 'tools' && action === 'policies' && rest[0] === 'set') {
      const agentId = required(rest[1], 'AGENT_ID')
      const policies: Array<{ toolId: string; effect: 'allow' | 'deny' | 'approval' }> = []
      for (let i = 2; i < rest.length; i++) {
        const arg = rest[i]!
        if (!arg.startsWith('--policy=')) throw new CliUsageError(`Unexpected argument: ${arg}`)
        const specification = arg.slice('--policy='.length)
        const separator = specification.lastIndexOf('=')
        const toolId = specification.slice(0, separator)
        const effect = specification.slice(separator + 1)
        if (separator <= 0 || !['allow', 'deny', 'approval'].includes(effect)) throw new CliUsageError('--policy must use TOOL_ID=allow|deny|approval')
        policies.push({ toolId, effect: effect as 'allow' | 'deny' | 'approval' })
      }
      if (!policies.length) throw new CliUsageError('tools policies set requires at least one --policy=TOOL_ID=allow|deny|approval')
      data = await client.replaceAgentToolPolicies(agentId, policies)
    } else if (group === 'worktrees' && action === 'create') {
      const projectId = required(rest[0], 'PROJECT_ID')
      const branch = required(optionValue(rest, '--branch'), '--branch')
      const sourceRef = required(optionValue(rest, '--source-ref'), '--source-ref')
      const expectedSha = required(optionValue(rest, '--expected-sha'), '--expected-sha')
      data = await client.createWorktree(projectId, { approved: true, branch, sourceRef, expectedSha })
    } else if (group === 'repository' && action === 'status') {
      data = await client.repositoryStatus(required(rest[0], 'PROJECT_ID'))
    } else if (group === 'approvals' && action === 'list') data = await client.approvals(optionValue(rest, '--session'))
    else if (group === 'approvals' && action === 'inspect') {
      const approvalId = required(rest[0], 'APPROVAL_ID'); const sessionId = optionValue(rest, '--session')
      const approval = await client.inspectApproval(approvalId, sessionId)
      data = approval
      if (!data) throw new CliUsageError(`Approval not found: ${approvalId}`)
    } else if (group === 'approvals' && action === 'decision') {
      const approvalId = required(rest[0], 'APPROVAL_ID'); const sessionId = required(optionValue(rest, '--session'), '--session')
      const decision = required(optionValue(rest, '--response'), '--response')
      if (!['approve', 'reject', 'once', 'always'].includes(decision)) throw new CliUsageError('--response must be approve, reject, once, or always')
      data = await client.respondToApproval(sessionId, approvalId, decision as 'approve' | 'reject' | 'once' | 'always')
    } else if (group === 'settings' && action === 'inspect') {
      if (!client.getSettings) unsupported('Settings inspection is not available in the installed @subpolar/client')
      data = await client.getSettings()
    } else if (group === 'settings' && action === 'update') {
      if (!client.updateSettings) unsupported('Settings updates are not available in the installed @subpolar/client')
      const input: Record<string, unknown> = {}
      for (let i = 0; i < rest.length; i++) {
        const key = rest[i]!
        if (!key.startsWith('--')) throw new CliUsageError(`Unexpected argument: ${key}`)
        const field = key.slice(2)
        if (!field) throw new CliUsageError('Settings keys cannot be empty')
        input[field] = parseScalar(valueAfter(rest, i++, key))
      }
      if (!Object.keys(input).length) throw new CliUsageError('settings update requires at least one --key VALUE')
      data = await client.updateSettings(input)
    } else throw new CliUsageError(USAGE)

    if (!streamed) stdout(json ? `${JSON.stringify({ ok: true, command, requestId, data })}\n` : human(data))
    else if (json) stdout(`${JSON.stringify({ event: 'result', ok: true, command, requestId, data })}\n`)
    return 0
  } catch (error) {
    const usage = error instanceof CliUsageError
    const isUnsupported = error instanceof UnsupportedCommandError
    const runtimeError = error instanceof CliRuntimeResultError ? error : undefined
    const apiError = error instanceof SubpolarApiError ? error : undefined
    const payload = { ok: false, command, error: { code: timedOut ? 'TIMEOUT' : isUnsupported ? 'UNSUPPORTED' : usage ? 'USAGE' : runtimeError?.code ?? apiError?.code ?? 'REQUEST_FAILED', message: timedOut ? 'Request timed out' : error instanceof Error ? error.message : 'Request failed', ...(runtimeError?.state ? { state: runtimeError.state } : {}), ...(runtimeError?.recoverable === undefined ? {} : { recoverable: runtimeError.recoverable }), ...(apiError ? { status: apiError.status, requestId: apiError.requestId } : {}) } }
    if (json) stdout(`${JSON.stringify(payload)}\n`)
    else stderr(`Error [${payload.error.code}]: ${payload.error.message}\n`)
    return timedOut ? 3 : usage ? 2 : isUnsupported ? 5 : apiError?.status === 401 || apiError?.status === 403 ? 4 : 1
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2))
