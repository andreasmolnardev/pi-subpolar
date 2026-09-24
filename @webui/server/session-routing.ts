import type { Api, AssistantMessage, Model, TextContent } from '@earendil-works/pi-ai'
import type { ProviderRuntime } from './provider-runtime.ts'

export type SessionRoutingCandidate = {
  id: string
  agentName: string
  projectName?: string
  description?: string
}

export class SessionRoutingError extends Error {
  readonly code = 'SESSION_ROUTING_FAILED'

  constructor(message: string) {
    super(message)
    this.name = 'SessionRoutingError'
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

function parseJsonResponse(text: string): Record<string, unknown> {
  const unfenced = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  try {
    const parsed: unknown = JSON.parse(unfenced)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    const record = parsed as Record<string, unknown>
    if (Object.keys(record).length !== 1 || !Object.prototype.hasOwnProperty.call(record, 'targetAgentId')) throw new Error('unexpected properties')
    return record
  } catch {
    throw new SessionRoutingError('Routing model returned invalid JSON')
  }
}

export function routingPrompt(candidates: readonly SessionRoutingCandidate[]): string {
  const list = candidates.map(({ id, agentName, projectName, description }) => ({
    id,
    agent: agentName,
    ...(projectName ? { project: projectName } : {}),
    ...(description ? { description } : {}),
  }))
  return JSON.stringify(list)
}

export async function routeSessionRequest(input: {
  runtime: ProviderRuntime
  model: Model<Api>
  request: string
  candidates: readonly SessionRoutingCandidate[]
}): Promise<SessionRoutingCandidate> {
  if (input.candidates.length === 0) throw new SessionRoutingError('No agents are available for routing')

  const response = await input.runtime.completeSimple(input.model, {
    systemPrompt: [
      'You route the first message of a conversation to the best matching agent.',
      'You have no tools and must not attempt to use any.',
      'Return only valid JSON with exactly one property: {"targetAgentId":"<candidate id>"}.',
      'Choose only an id from the supplied candidate list.',
      'Do not include markdown, explanation, or any other properties.',
    ].join(' '),
    messages: [{
      role: 'user',
      content: `Request:\n${input.request}\n\nAvailable agents:\n${routingPrompt(input.candidates)}`,
      timestamp: Date.now(),
    }],
    // Deliberately omit `tools`: the routing model must never receive tools.
  })

  const parsed = parseJsonResponse(assistantText(response))
  if (typeof parsed.targetAgentId !== 'string' || !parsed.targetAgentId.trim()) {
    throw new SessionRoutingError('Routing model did not return targetAgentId')
  }

  const target = input.candidates.find((candidate) => candidate.id === parsed.targetAgentId)
  if (!target) throw new SessionRoutingError('Routing model returned an unknown targetAgentId')
  return target
}

export function parseRoutingModelSelection(value: unknown): { providerID: string; modelID: string } | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const [providerID, ...parts] = value.trim().split('/')
  const modelID = parts.join('/')
  return providerID && modelID ? { providerID, modelID } : undefined
}
