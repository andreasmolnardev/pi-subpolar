#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { SubpolarApiError, SubpolarClient } from '@subpolar/client'
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_URL = 'http://localhost:4173'
const USAGE = `Usage: subpolar-test-cli [--url URL] [--env NAME | --profile NAME] [--token USER_TOKEN] [--timeout MS] [--json|--jsonl] <command>
Commands:
  status
  agents list
  models list
  projects list
  sessions list [--project ID] [--search TEXT]
  sessions create [--title TEXT] [--project ID] [--directory PATH] [--agent NAME] [--model ID] [--thinking LEVEL] [--permission MODE] [--worktree ID]
  sessions send <SESSION_ID> <MESSAGE>
  sessions inspect <SESSION_ID>
  sessions events <SESSION_ID> [--after ID] [--limit N]
  sessions errors <SESSION_ID>
  sessions abort <SESSION_ID>
  runs inspect <RUN_ID>                    (not exposed by current server API)
  test <scenario.yaml>`

export interface CliIo { stdout?: (text: string) => void; stderr?: (text: string) => void }
export interface CliOptions { fetch?: FetchLike; io?: CliIo; token?: string; baseUrl?: string }
export class CliUsageError extends Error {}

function getValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new CliUsageError(`${option} requires a value`)
  return value
}

function parseOptions(argv: string[]) {
  const args: string[] = []
  let url: string | undefined
  let env: string | undefined
  let profile: string | undefined
  let token: string | undefined
  let timeout = 30_000
  let json = false
  let jsonl = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--url') url = getValue(argv, i++, arg)
    else if (arg === '--env') env = getValue(argv, i++, arg)
    else if (arg === '--profile') profile = getValue(argv, i++, arg)
    else if (arg === '--token') token = getValue(argv, i++, arg)
    else if (arg === '--timeout') {
      timeout = Number(getValue(argv, i++, arg))
      if (!Number.isInteger(timeout) || timeout < 1) throw new CliUsageError('--timeout must be a positive integer in milliseconds')
    } else if (arg === '--json') json = true
    else if (arg === '--jsonl') jsonl = true
    else if (arg.startsWith('--')) {
      args.push(arg)
      if (['--project', '--search', '--title', '--after', '--limit', '--agent', '--model', '--thinking', '--directory', '--worktree', '--permission'].includes(arg)) args.push(getValue(argv, i++, arg))
    } else args.push(arg)
  }
  if (env && profile) throw new CliUsageError('--env and --profile cannot be combined')
  if (json && jsonl) throw new CliUsageError('--json and --jsonl cannot be combined')
  return { args, url, env, profile, token, timeout, json, jsonl }
}

function yamlScalar(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) as unknown } catch { throw new CliUsageError(`Invalid inline YAML value: ${trimmed}`) }
  }
  return trimmed.replace(/\s+#.*$/, '')
}

/** Parse the documented scenario subset: scalar top-level fields and a `messages` string list. */
export function parseScenario(text: string): { title?: string; project?: string | number; messages: string[] } {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return validateScenario(value)
  } catch (error) {
    if (error instanceof CliUsageError) throw error
  }
  const result: Record<string, unknown> = {}
  const messages: string[] = []
  let inMessages = false
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (/^messages\s*:\s*$/.test(line.trim())) { inMessages = true; result.messages = messages; continue }
    if (inMessages && /^\s+-\s+/.test(line)) {
      const value = yamlScalar(line.replace(/^\s+-\s+/, ''))
      if (typeof value !== 'string') throw new CliUsageError(`messages entry on line ${index + 1} must be a string`)
      messages.push(value); continue
    }
    inMessages = false
    const match = line.match(/^(title|project)\s*:\s*(.*?)\s*$/)
    if (!match) throw new CliUsageError(`Unsupported scenario YAML on line ${index + 1}; see README.md`)
    result[match[1]!] = yamlScalar(match[2]!)
  }
  return validateScenario(result)
}

function validateScenario(value: Record<string, unknown>): { title?: string; project?: string | number; messages: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliUsageError('Scenario must be an object')
  const allowed = new Set(['title', 'project', 'messages'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new CliUsageError(`Unknown scenario key: ${key}`)
  if (value.title !== undefined && typeof value.title !== 'string') throw new CliUsageError('Scenario title must be a string')
  if (value.project !== undefined && typeof value.project !== 'string' && typeof value.project !== 'number') throw new CliUsageError('Scenario project must be a string or number')
  if (value.messages !== undefined && (!Array.isArray(value.messages) || value.messages.some((item) => typeof item !== 'string' || !item.trim()))) throw new CliUsageError('Scenario messages must be a list of non-empty strings')
  return { ...(typeof value.title === 'string' ? { title: value.title } : {}), ...(typeof value.project === 'string' || typeof value.project === 'number' ? { project: value.project } : {}), messages: (value.messages as string[] | undefined) ?? [] }
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.io?.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = options.io?.stderr ?? ((text: string) => process.stderr.write(text))
  let mode = 'text'
  let command = 'unknown'
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const parsed = parseOptions(argv)
    mode = parsed.json ? 'json' : parsed.jsonl ? 'jsonl' : 'text'
    const [group, action, ...rest] = parsed.args
    command = [group, action].filter(Boolean).join(' ')
    if (!group) throw new CliUsageError(USAGE)
    const selector = parsed.profile ? `PROFILE_${parsed.profile.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` : parsed.env ? `ENV_${parsed.env.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` : undefined
    const baseUrl = options.baseUrl ?? parsed.url ?? (selector ? process.env[`SUBPOLAR_${selector}_URL`] : undefined) ?? process.env.SUBPOLAR_URL ?? DEFAULT_URL
    const userToken = options.token ?? parsed.token ?? (selector ? process.env[`SUBPOLAR_${selector}_TOKEN`] : undefined) ?? process.env.SUBPOLAR_TOKEN
    const requestId = `subpolar-test-${crypto.randomUUID()}`
    const controller = new AbortController()
    timer = setTimeout(() => { timedOut = true; controller.abort(new Error('Request timed out')) }, parsed.timeout)
    const transport: FetchLike = async (input, init = {}) => {
      const headers = new Headers(init.headers)
      headers.set('x-request-id', requestId)
      return (options.fetch ?? fetch)(input, { ...init, headers, signal: init.signal ?? controller.signal })
    }
    const client = new SubpolarClient({ baseUrl, token: userToken, fetch: transport })
    let data: unknown
    if (group === 'status' && action === undefined) {
      data = { health: await client.health(), capabilities: await client.capabilities(), baseUrl, requestId }
    } else if (group === 'agents' && action === 'list') data = await client.listAgents()
    else if (group === 'models' && action === 'list') data = await client.listModels()
    else if (group === 'projects' && action === 'list') data = await client.listProjects()
    else if (group === 'sessions' && action === 'list') {
      const project = optionValue(rest, '--project'); const search = optionValue(rest, '--search')
      data = await client.listSessions({ ...(project ? { project } : {}), ...(search ? { search } : {}) })
    } else if (group === 'sessions' && action === 'create') {
      const title = optionValue(rest, '--title'); const project = optionValue(rest, '--project')
      const directory = optionValue(rest, '--directory'); const agent = optionValue(rest, '--agent')
      const model = optionValue(rest, '--model'); const thinking = optionValue(rest, '--thinking')
      const permission = optionValue(rest, '--permission'); const worktreeId = optionValue(rest, '--worktree')
      const validThinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking ?? '') ? thinking as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' : undefined
      const validPermission = ['ask', 'none', 'allow_all'].includes(permission ?? '') ? permission as 'ask' | 'none' | 'allow_all' : undefined
      if (thinking && !validThinking) throw new CliUsageError('--thinking must be off, minimal, low, medium, high, or xhigh')
      if (permission && !validPermission) throw new CliUsageError('--permission must be ask, none, or allow_all')
      data = await client.createSession({ ...(title ? { title } : {}), ...(project ? { project } : {}), ...(directory ? { directory } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(validThinking ? { thinking: validThinking } : {}), ...(validPermission ? { permission: validPermission } : {}), ...(worktreeId ? { worktreeId } : {}) })
    } else if (group === 'sessions' && action === 'send') {
      if (rest.length < 2) throw new CliUsageError('sessions send requires <SESSION_ID> <MESSAGE>')
      const [id, ...message] = rest.filter((item) => !item.startsWith('--'))
      if (!id || !message.length) throw new CliUsageError('sessions send requires <SESSION_ID> <MESSAGE>')
      data = await client.run(id, message.join(' '), { messageID: requestId, metadata: { requestId } })
    } else if (group === 'sessions' && action === 'inspect') {
      const id = required(rest[0], 'SESSION_ID')
      data = { session: await client.getSession(id), messages: await client.messages(id) }
    } else if (group === 'sessions' && action === 'errors') {
      const id = required(rest[0], 'SESSION_ID')
      const messages = await client.messages(id)
      data = (messages as unknown[]).filter((item: unknown) => item && typeof item === 'object' && ('error' in item || (item as Record<string, unknown>).type === 'error'))
    } else if (group === 'sessions' && action === 'abort') data = await client.abortRun(required(rest[0], 'SESSION_ID'))
    else if (group === 'sessions' && action === 'events') {
      const sessionId = required(rest[0], 'SESSION_ID'); const after = optionValue(rest, '--after'); const limit = Number(optionValue(rest, '--limit') ?? '0')
      if (limit < 0 || !Number.isInteger(limit)) throw new CliUsageError('--limit must be a non-negative integer')
      const events: unknown[] = []
      for await (const event of client.events({ sessionId, ...(after ? { after } : {}), signal: controller.signal })) {
        events.push(event)
        if (mode === 'jsonl') stdout(`${JSON.stringify({ event: 'data', ...event })}\n`)
        if (limit && events.length >= limit) { controller.abort(); break }
      }
      data = events
    } else if (group === 'runs' && action === 'inspect') throw new UnsupportedCommandError('The server currently exposes run inspection only through session events; no public per-run inspection route exists.')
    else if (group === 'test' && action === undefined) {
      const path = rest[0]
      if (!path) throw new CliUsageError('test requires <scenario.yaml>')
      const scenario = parseScenario(await readFile(path, 'utf8'))
      const session = await client.createSession({ ...(scenario.title ? { title: scenario.title } : {}), ...(scenario.project !== undefined ? { project: scenario.project } : {}) })
      const results = []
      for (const message of scenario.messages) results.push(await client.run(session.id, message, { messageID: `${requestId}-${results.length + 1}`, metadata: { requestId } }))
      data = { ok: true, scenario: path, session, results, requestId }
    } else throw new CliUsageError(USAGE)
    clearTimeout(timer)
    if (mode === 'json') stdout(`${JSON.stringify({ ok: true, command, requestId, data })}\n`)
    else if (mode === 'jsonl' && !(group === 'sessions' && action === 'events')) stdout(`${JSON.stringify({ event: 'result', ok: true, command, requestId, data })}\n`)
    else if (mode === 'text') stdout(format(data))
    return 0
  } catch (error) {
    if (timer) clearTimeout(timer)
    const usage = error instanceof CliUsageError
    const unsupported = error instanceof UnsupportedCommandError
    const apiError: SubpolarApiError | undefined = error instanceof SubpolarApiError ? error : undefined
    const payload = { ok: false, command, error: { code: timedOut ? 'TIMEOUT' : unsupported ? 'UNSUPPORTED' : usage ? 'USAGE' : apiError?.code ?? 'REQUEST_FAILED', message: timedOut ? 'Request timed out' : error instanceof Error ? error.message : 'Request failed', ...(apiError ? { status: apiError.status, requestId: apiError.requestId } : {}) } }
    if (mode === 'json' || mode === 'jsonl') stdout(`${JSON.stringify(mode === 'jsonl' ? { event: 'error', ...payload } : payload)}\n`)
    else stderr(`Error [${payload.error.code}]: ${payload.error.message}\n`)
    return timedOut ? 3 : usage ? 2 : unsupported ? 5 : apiError?.status === 401 || apiError?.status === 403 ? 4 : 1
  }
}

class UnsupportedCommandError extends Error {}
function required(value: string | undefined, name: string): string { if (!value || value.startsWith('--')) throw new CliUsageError(`Missing ${name}`); return value }
function optionValue(args: string[], option: string): string | undefined { const i = args.indexOf(option); return i < 0 ? undefined : getValue(args, i, option) }
function format(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map((item) => `- ${format(item).trim()}`).join('\n') + '\n' : '(none)\n'
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2) + '\n'
  return `${String(value)}\n`
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2))
