import { Type } from 'typebox'
import type { ToolGateway } from '../../server/tool-gateway.ts'

type ToolCall = {
  id?: unknown
  toolCallId?: unknown
  name?: unknown
  toolName?: unknown
  input?: unknown
  args?: unknown
  cwd?: unknown
}

type ExtensionResult = { content: unknown[]; details: Record<string, unknown> }
type ExtensionApi = any

type RoutingContext = {
  baseUrl?: string
  internalToken?: string
  gateway?: ToolGateway
  userId: string
  agentName: string
  sessionId: string
  cwd: string
  permissionOverride?: 'ask' | 'none' | 'allow_all'
  capabilities?: readonly string[]
  onApproval?: (approval: import('../../server/tools.ts').Approval) => void | Promise<void>
  listTools?: () => Promise<unknown>
  searchTools?: (query: string) => Promise<unknown>
  describeTool?: (toolId: string) => Promise<unknown>
}

export const centralToolNames = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'search-tool', 'subpolar-tools'] as const
const centralToolNameSet = new Set<string>(centralToolNames)
const inputSchema = Type.Object({
  action: Type.String({ enum: ['list', 'describe', 'call'] }),
  toolId: Type.Optional(Type.String()),
  input: Type.Optional(Type.Object({}, { additionalProperties: true })),
})

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function toolName(event: ToolCall): string {
  return stringValue(event.toolName ?? event.name, '')
}


function textResult(value: unknown, details: Record<string, unknown> = {}): ExtensionResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details }
}

function endpoint(context: RoutingContext, path: string): string {
  const baseUrl = context.baseUrl
  if (!baseUrl) throw new Error('Tool gateway is not configured')
  return `${baseUrl.replace(/\/+$/, '')}/api${path}`
}

async function gateway(context: RoutingContext, path: string, requestBody: Record<string, unknown>): Promise<ExtensionResult> {
  if (context.searchTools && path.endsWith('/search') && typeof requestBody.query === 'string') {
    const value = await context.searchTools(requestBody.query)
    const tools = Array.isArray(value) ? value as Array<Record<string, unknown>> : []
    const rows = tools.map((tool) => `${String(tool.tool)} | ${String(tool.description)} | ${String(tool.usage)}`)
    return textResult(['tool | description | usage', ...rows].join('\n'), { tools })
  }
  if (context.listTools && path.endsWith('/list')) return textResult(await context.listTools())
  if (context.describeTool && path.endsWith('/describe') && typeof requestBody.toolId === 'string') return textResult(await context.describeTool(requestBody.toolId))
  if (context.gateway && path.endsWith('/call') && typeof requestBody.toolId === 'string') {
    const result = await context.gateway.call(
      { toolId: requestBody.toolId, input: requestBody.input ?? {} },
      {
        userId: context.userId,
        agentName: context.agentName,
        sessionId: context.sessionId,
        cwd: context.cwd,
        callId: typeof requestBody.callId === 'string' ? requestBody.callId : undefined,
        permissionOverride: context.permissionOverride,
        waitForApproval: false,
        onApproval: context.onApproval,
        capabilities: context.capabilities,
      },
    )
    if (result.ok && result.result && typeof result.result === 'object' && Array.isArray((result.result as Record<string, unknown>).content)) return result.result as ExtensionResult
    return textResult(result, { routedTo: 'in-process-tool-gateway' })
  }
  if (!context.baseUrl || !context.internalToken) return textResult({ ok: false, error: 'Tool gateway is not configured' })
  const response = await fetch(endpoint(context, path), {
    method: 'POST',
    headers: { authorization: `Bearer ${context.internalToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  const value = await response.json().catch(() => ({ error: 'Bridge returned an invalid response' })) as Record<string, unknown>
  if (response.ok && path.endsWith('/search') && Array.isArray(value.tools)) {
    const rows = (value.tools as Array<Record<string, unknown>>).map((tool) => `${String(tool.tool)} | ${String(tool.description)} | ${String(tool.usage)}`)
    return textResult(['tool | description | usage', ...rows].join('\n'), { tools: value.tools })
  }
  if (response.ok && value.ok === true && value.result && typeof value.result === 'object' && Array.isArray((value.result as Record<string, unknown>).content)) {
    return value.result as ExtensionResult
  }
  return textResult(value, { routedTo: 'pocketbase-tool-router', status: response.status })
}

function callBody(context: RoutingContext, toolId: string, input: unknown, callId: string): Record<string, unknown> {
  return {
    userId: context.userId,
    agentName: context.agentName,
    sessionId: context.sessionId,
    cwd: context.cwd,
    callId,
    toolId,
    input: input ?? {},
    permissionOverride: context.permissionOverride,
  }
}

function registerBuiltinTools(pi: ExtensionApi, context: RoutingContext): void {
  const definitions = {
    read: {
      label: 'Read',
      description: 'Read file contents from the selected project.',
      parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
    },
    write: {
      label: 'Write',
      description: 'Create or overwrite a file in the selected project.',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    },
    edit: {
      label: 'Edit',
      description: 'Apply precise text edits to a file in the selected project.',
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
      }),
    },
    bash: {
      label: 'Bash',
      description: 'Execute a bash command in the selected project.',
      parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    },
    grep: {
      label: 'Grep',
      description: 'Search file contents in the selected project.',
      parameters: Type.Object({
        pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()),
        ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()),
        context: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()),
      }),
    },
    find: {
      label: 'Find',
      description: 'Find files by glob pattern in the selected project.',
      parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
    },
    ls: {
      label: 'List files',
      description: 'List directory contents in the selected project.',
      parameters: Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
    },
  } as const

  for (const [name, definition] of Object.entries(definitions)) {
    pi.registerTool({
      name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.description,
      parameters: definition.parameters,
      async execute(toolCallId: string, params: unknown) {
        return gateway(context, '/subpolar-cli/tools/call', callBody(context, name, params, toolCallId))
      },
    })
  }
}

function registerDiscoveryTools(pi: ExtensionApi, context: RoutingContext): void {
  pi.registerTool({
    name: 'search-tool',
    label: 'Search Tools',
    description: 'Search the tools available to the active agent. Query is required.',
    promptSnippet: 'Search available tools by name or description',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: 'Non-empty search query for tool names or descriptions' }),
    }),
    async execute(_toolCallId: string, params: { query: string }) {
      return gateway(context, '/subpolar-cli/tools/search', {
        userId: context.userId,
        agentName: context.agentName,
        query: params.query,
      })
    },
  })

  pi.registerTool({
    name: 'subpolar-tools',
    label: 'Subpolar Tools',
    description: 'Describe and call external tools governed by the PocketBase-backed Subpolar tool router.',
    parameters: inputSchema,
    async execute(_toolCallId: string, params: { action?: unknown; toolId?: unknown; input?: unknown }) {
      const value = params && typeof params === 'object' ? params : {}
      if (value.action === 'list') return gateway(context, '/subpolar-cli/tools/list', { userId: context.userId, agentName: context.agentName })
      if (value.action === 'describe' && typeof value.toolId === 'string') return gateway(context, '/subpolar-cli/tools/describe', { userId: context.userId, agentName: context.agentName, toolId: value.toolId })
      if (value.action === 'call' && typeof value.toolId === 'string') return gateway(context, '/subpolar-cli/tools/call', callBody(context, value.toolId, value.input ?? {}, _toolCallId))
      return textResult({ ok: false, error: 'action must be list, describe, or call; toolId is required for describe and call' })
    },
  })
}

async function authorize(_context: RoutingContext, event: ToolCall): Promise<void | { block: true; reason: string }> {
  const name = toolName(event)
  if (centralToolNameSet.has(name)) return undefined
  return { block: true, reason: `Tool ${name || '(unknown)'} is not available outside the central Subpolar tool router` }
}

export function createToolRoutingExtension(context: RoutingContext) {
  return (pi: ExtensionApi): void => {
    registerBuiltinTools(pi, context)
    registerDiscoveryTools(pi, context)
    const register = pi.hook ?? pi.on
    if (register) register.call(pi, 'tool_call', (event: ToolCall) => authorize(context, event))
  }
}
