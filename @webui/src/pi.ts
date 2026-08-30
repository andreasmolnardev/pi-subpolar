export type Project = { name: string; path: string }

export type Session = {
  id: string
  project: string
  title: string
  createdAt: number
  updatedAt: number
}

export type PiContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

export type PiMessage = {
  role: string
  content: string | PiContent[]
  timestamp?: number
  [key: string]: unknown
}

export type RpcEvent = {
  type?: string
  message?: PiMessage
  assistantMessageEvent?: { type?: string; delta?: string }
  toolName?: string
  [key: string]: unknown
}

export type RpcResponse = { type: 'response'; success: boolean; data?: Record<string, unknown>; error?: string; [key: string]: unknown }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const value = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `Request failed: ${response.status}`)
  return value
}

export const piApi = {
  projects: () => request<{ projects: Project[] }>('/api/projects'),
  sessions: (project: string) => request<{ sessions: Session[] }>(`/api/sessions?project=${encodeURIComponent(project)}`),
  createSession: (project: string) => request<{ session: Session }>('/api/sessions', { method: 'POST', body: JSON.stringify({ project }) }),
  messages: (sessionId: string) => request<RpcResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
  state: (sessionId: string) => request<RpcResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/state`),
  stats: (sessionId: string) => request<RpcResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/stats`),
  prompt: (sessionId: string, message: string) => request<RpcResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { method: 'POST', body: JSON.stringify({ message }) }),
  rpc: (sessionId: string, command: Record<string, unknown>) => request<RpcResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/rpc`, { method: 'POST', body: JSON.stringify(command) }),
  rename: (sessionId: string, title: string) => request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  activateProject: (sessionId: string, project: string) => request<RpcResponse>('/api/extensions/projects', { method: 'POST', body: JSON.stringify({ sessionId, project }) }),
  profiles: () => request<{ profiles: Record<string, { systemPrompt?: string; tools?: string[] }> }>('/api/extensions/profiles'),
  activateProfile: (sessionId: string, profile: string) => request<RpcResponse>('/api/extensions/profiles/activate', { method: 'POST', body: JSON.stringify({ sessionId, profile }) }),
  tools: (sessionId: string) => request<{ tools: string[] }>(`/api/extensions/tools?sessionId=${encodeURIComponent(sessionId)}`),
  commands: (sessionId: string) => request<RpcResponse>(`/api/extensions/commands?sessionId=${encodeURIComponent(sessionId)}`),
  search: (query: string) => request<{ sessions: Session[] }>(`/api/extensions/session-search?q=${encodeURIComponent(query)}`),
  usage: () => request<{ sessions: Array<{ session: Session; stats: Record<string, unknown> | null }> }>('/api/extensions/usage'),
}

export function sessionEventsUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/sessions/${encodeURIComponent(sessionId)}/events`
}

export function messageText(message: PiMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.map((part) => part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking : `${part.name}: ${JSON.stringify(part.arguments)}`).join('\n')
}

export function messageParts(message: PiMessage): Array<{ type: string; text: string }> {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  return message.content.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : part.type === 'thinking'
      ? { type: 'thinking', text: part.thinking }
      : { type: 'tool', text: `${part.name}\n${JSON.stringify(part.arguments, null, 2)}` })
}
