#!/usr/bin/env bun
import type { CreateAutomationInput } from '../../subpolar-client/src/index.ts'
import { createInterface } from 'node:readline/promises'

export interface CliIo {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  prompt?: (message: string, secret: boolean) => Promise<string>
}

export interface CliEnvironment {
  SUBPOLAR_API_URL?: string
  SUBPOLAR_API_TOKEN?: string
}

export interface ParsedArgs {
  baseUrl: string
  token?: string
  json: boolean
  help: boolean
  command: string[]
}

export class CliUsageError extends Error {
  readonly code = 'CLI_USAGE_ERROR'
}

export function parseArgs(argv: string[], env: CliEnvironment = process.env): ParsedArgs {
  let baseUrl = env.SUBPOLAR_API_URL?.trim() || 'http://localhost:4173'
  let token = env.SUBPOLAR_API_TOKEN?.trim() || undefined
  let json = false
  let help = false
  const command: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--base-url' || arg === '--token') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new CliUsageError(`${arg} requires a value`)
      if (arg === '--base-url') baseUrl = value
      else token = value
      index += 1
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg.startsWith('--')) {
      throw new CliUsageError(`Unknown option: ${arg}`)
    } else {
      command.push(arg)
    }
  }
  let parsedUrl: URL
  try { parsedUrl = new URL(baseUrl) } catch { throw new CliUsageError('--base-url must be an absolute URL') }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new CliUsageError('--base-url must use HTTP or HTTPS')
  return { baseUrl: parsedUrl.toString().replace(/\/$/, ''), token, json, help, command }
}

export function usage(): string {
  return [
    'Usage: subpolar-test-cli [--base-url URL] [--token TOKEN] [--json] automations <command> [args]',
    '       subpolar-test-cli [--base-url URL] [--token TOKEN] providers login <provider-id> [account-label]',
    '',
    'Commands:',
    '  automations list',
    '  automations get <automation-id>',
    '  automations create <json-object>',
    '  automations enable <automation-id>',
    '  automations disable <automation-id>',
    '  automations run <automation-id> [trigger-payload-json]',
    '  automations executions <automation-id>',
    '  automations execution <automation-id> <execution-id>',
    '  automations cancel <automation-id> <execution-id>',
    '  providers login <provider-id> [account-label]  Connect a provider with an API key',
  ].join('\n')
}

interface RequestPlan {
  method: string
  path: string
  body?: unknown
}

function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value) as unknown } catch { throw new CliUsageError(`${label} must be valid JSON`) }
}

export function planRequest(command: string[]): RequestPlan {
  const [resource, action, ...args] = command
  if (resource !== 'automations' || !action) throw new CliUsageError('Expected automations <command>')
  const base = '/api/v1/automations'
  const id = args[0]
  const encodedId = id ? encodeURIComponent(id) : ''
  switch (action) {
    case 'list':
      if (args.length) throw new CliUsageError('automations list takes no arguments')
      return { method: 'GET', path: base }
    case 'get':
      if (!id || args.length !== 1) throw new CliUsageError('Usage: automations get <automation-id>')
      return { method: 'GET', path: `${base}/${encodedId}` }
    case 'create': {
      if (!id || args.length !== 1) throw new CliUsageError('Usage: automations create <json-object>')
      const body = parseJson(id, 'Automation definition')
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CliUsageError('Automation definition must be a JSON object')
      return { method: 'POST', path: base, body: body as CreateAutomationInput }
    }
    case 'enable':
    case 'disable':
      if (!id || args.length !== 1) throw new CliUsageError(`Usage: automations ${action} <automation-id>`)
      return { method: 'POST', path: `${base}/${encodedId}/${action}` }
    case 'run':
      if (!id || args.length > 2) throw new CliUsageError('Usage: automations run <automation-id> [trigger-payload-json]')
      return { method: 'POST', path: `${base}/${encodedId}/run`, ...(args[1] ? { body: { payload: parseJson(args[1], 'Trigger payload') } } : { body: {} }) }
    case 'executions':
      if (!id || args.length !== 1) throw new CliUsageError('Usage: automations executions <automation-id>')
      return { method: 'GET', path: `${base}/${encodedId}/executions` }
    case 'execution':
    case 'cancel': {
      const executionId = args[1]
      if (!id || !executionId || args.length !== 2) throw new CliUsageError(`Usage: automations ${action} <automation-id> <execution-id>`)
      const path = `${base}/${encodedId}/executions/${encodeURIComponent(executionId)}`
      return { method: action === 'cancel' ? 'POST' : 'GET', path: action === 'cancel' ? `${path}/cancel` : path }
    }
    default:
      throw new CliUsageError(`Unknown automations command: ${action}`)
  }
}

function redact(text: string, token?: string): string {
  return token ? text.split(token).join('[redacted]') : text
}

export async function runCli(
  argv: string[],
  options: { env?: CliEnvironment; fetch?: typeof fetch } = {},
  io: CliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text))
  const stderr = io.stderr ?? ((text) => process.stderr.write(text))
  let parsed: ParsedArgs | undefined
  try {
    parsed = parseArgs(argv, options.env)
    if (parsed.help) {
      stdout(`${usage()}\n`)
      return 0
    }
    if (!parsed.token) throw new CliUsageError('Set SUBPOLAR_API_TOKEN or pass --token with a normal authenticated Subpolar user token')
    if (parsed.command[0] === 'providers') {
      const [, action, providerInstanceId, displayName, ...extra] = parsed.command
      if (action !== 'login' || !providerInstanceId || extra.length) throw new CliUsageError('Usage: providers login <provider-id> [account-label]')
      const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
      const headers = { Authorization: `Bearer ${parsed.token}`, Accept: 'application/json', 'Content-Type': 'application/json' }
      const startResponse = await requestFetch(`${parsed.baseUrl}/api/providers/login-flows`, {
        method: 'POST', headers,
        body: JSON.stringify({ providerInstanceId, type: 'api_key', ...(displayName ? { displayName } : {}) }),
      })
      const startText = await startResponse.text()
      const started = parseResponse(startText)
      if (!startResponse.ok) throw apiError(startResponse.status, started, parsed.token)
      let flow = (started as { flow?: LoginFlowStatus }).flow ?? started as LoginFlowStatus
      const prompt = io.prompt ?? promptForInput
      while (flow.phase === 'pending') {
        if (flow.currentPrompt) {
          const value = await prompt(flow.currentPrompt.prompt.message, flow.currentPrompt.prompt.type === 'secret')
          const response = await requestFetch(`${parsed.baseUrl}/api/providers/login-flows/${encodeURIComponent(flow.flowId)}/respond`, {
            method: 'POST', headers,
            body: JSON.stringify({ promptId: flow.currentPrompt.promptId, value }),
          })
          const responseData = parseResponse(await response.text())
          if (!response.ok) throw apiError(response.status, responseData, parsed.token)
          flow = (responseData as { status?: LoginFlowStatus }).status ?? responseData as LoginFlowStatus
        } else {
          await new Promise((resolve) => setTimeout(resolve, 300))
          const response = await requestFetch(`${parsed.baseUrl}/api/providers/login-flows/${encodeURIComponent(flow.flowId)}`, { headers })
          const responseData = parseResponse(await response.text())
          if (!response.ok) throw apiError(response.status, responseData, parsed.token)
          flow = (responseData as { status?: LoginFlowStatus }).status ?? responseData as LoginFlowStatus
        }
      }
      if (flow.phase !== 'completed') throw new Error(`Provider login ${flow.phase}`)
      stdout(`${JSON.stringify({ connected: true, providerInstanceId: flow.providerInstanceId, phase: flow.phase }, null, parsed.json ? undefined : 2)}\n`)
      return 0
    }
    const plan = planRequest(parsed.command)
    const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    const response = await requestFetch(`${parsed.baseUrl}${plan.path}`, {
      method: plan.method,
      headers: {
        Authorization: `Bearer ${parsed.token}`,
        Accept: 'application/json',
        ...(plan.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(plan.body === undefined ? {} : { body: JSON.stringify(plan.body) }),
    })
    const responseText = await response.text()
    let data: unknown
    try { data = responseText ? JSON.parse(responseText) : undefined } catch { data = responseText }
    if (!response.ok) {
      const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
      const message = typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : `API request failed (${response.status})`
      throw new Error(redact(message, parsed.token))
    }
    const printable = JSON.stringify(data, null, parsed.json ? undefined : 2) ?? 'null'
    stdout(`${redact(printable, parsed.token)}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CLI failed'
    const safeMessage = redact(message, parsed?.token)
    if (error instanceof CliUsageError) stderr(`${safeMessage}\n${usage()}\n`)
    else stderr(`${safeMessage}\n`)
    return error instanceof CliUsageError ? 2 : 1
  }
}

interface LoginFlowStatus {
  flowId: string
  providerInstanceId: string
  phase: 'pending' | 'completed' | 'failed' | 'cancelled' | 'expired'
  currentPrompt?: { promptId: string; prompt: { type: string; message: string } }
}

function parseResponse(text: string): unknown {
  try { return text ? JSON.parse(text) as unknown : undefined } catch { return text }
}

function apiError(status: number, data: unknown, token: string): Error {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const message = typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : `API request failed (${status})`
  return new Error(redact(message, token))
}

async function promptForInput(message: string, secret: boolean): Promise<string> {
  process.stdout.write(`${message}${secret ? ' (input hidden)' : ''}: `)
  if (!secret) {
    const readline = createInterface({ input: process.stdin, output: process.stdout })
    try { return (await readline.question('')).trim() } finally { readline.close() }
  }
  if (!process.stdin.isTTY) {
    const readline = createInterface({ input: process.stdin })
    try { return (await readline.question('')).trim() } finally { readline.close() }
  }
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()
  return await new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      stdin.off('data', onData)
      stdin.setRawMode(Boolean(wasRaw))
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return finish(new Error('Provider login cancelled'))
        if (char === '\r' || char === '\n') return finish()
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on('data', onData)
  })
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2))
