import { fetchWrapper } from './fetchWrapper'
import { API_BASE_URL } from '@/config'

export type McpStatus = 
  | { status: 'connected' }
  | { status: 'disabled' }
  | { status: 'failed'; error: string }
  | { status: 'needs_auth' }
  | { status: 'needs_client_registration'; error: string }

export type McpStatusMap = Record<string, McpStatus>

export interface McpServerConfig {
  type: 'local' | 'remote'
  enabled?: boolean
  command?: string[]
  url?: string
  environment?: Record<string, string>
  headers?: Record<string, string>
  timeout?: number
  oauth?: boolean | {
    clientId?: string
    clientSecret?: string
    scope?: string
  }
}

export function formatMcpCommand(args: string[]): string {
  return JSON.stringify(args)
}

/** Parse argv, never a shell command. JSON arrays support spaces and empty arguments. */
export function parseMcpCommand(value: string): string[] {
  const text = value.trim()
  if (!text) throw new Error('Command is required for local MCP servers')
  if (text.startsWith('[')) {
    let args: unknown
    try { args = JSON.parse(text) } catch { throw new Error('Command must be a valid JSON array of strings') }
    if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string' || !args[0].trim() || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new Error('Command must be a JSON array with a non-empty executable and string arguments')
    }
    return args
  }
  if (/["'\\]/.test(text)) throw new Error('Use a JSON argv array for quoted arguments or paths with spaces')
  return text.split(/\s+/)
}

export function validateMcpServerInput(name: string, config: McpServerConfig): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Server ID must be 1–64 lowercase letters, digits, hyphens or underscores')
  if (config.timeout !== undefined && (!Number.isSafeInteger(config.timeout) || config.timeout <= 0)) throw new Error('Timeout must be a positive integer in milliseconds')
  if (config.type === 'local') {
    if (!config.command?.length || !config.command[0]?.trim() || config.command.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('A local server requires an executable and string arguments')
  } else {
    let url: URL
    try { url = new URL(config.url ?? '') } catch { throw new Error('Remote server URL must be an absolute HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Remote server URL must use HTTP(S) without embedded credentials')
  }
}

export interface AddMcpServerRequest {
  name: string
  config: McpServerConfig
}

export interface McpAuthStartResponse {
  authorizationUrl: string
  flowId: string
}

export type McpOAuthFlowStatus = 
  | { status: 'pending' }
  | { status: 'completed'; serverName: string }
  | { status: 'failed'; error: string }
  | { status: 'unknown' }

export const mcpApi = {
  async getStatus(): Promise<McpStatusMap> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp`)
  },

  async addServer(name: string, config: McpServerConfig): Promise<McpStatusMap> {
    validateMcpServerInput(name, config)
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config }),
    })
  },

  async connect(name: string): Promise<boolean> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp/${encodeURIComponent(name)}/connect`, {
      method: 'POST',
    })
  },

  async disconnect(name: string): Promise<boolean> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp/${encodeURIComponent(name)}/disconnect`, {
      method: 'POST',
    })
  },

  async startAuth(name: string, serverUrl: string, scope?: string, clientId?: string, clientSecret?: string, directory?: string): Promise<McpAuthStartResponse> {
    return fetchWrapper(`${API_BASE_URL}/api/mcp-oauth-proxy/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName: name, serverUrl, scope, clientId, clientSecret, directory }),
    })
  },

  async checkFlowStatus(flowId: string): Promise<McpOAuthFlowStatus> {
    try {
      return await fetchWrapper(`${API_BASE_URL}/api/mcp-oauth-proxy/status/${encodeURIComponent(flowId)}`)
    } catch {
      return { status: 'unknown' }
    }
  },

  async completeAuth(name: string, code: string): Promise<McpStatus> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp/${encodeURIComponent(name)}/auth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  },

  async authenticate(name: string): Promise<McpStatus> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp/${encodeURIComponent(name)}/auth/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  },

  async removeAuth(name: string): Promise<{ success: true }> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp/${encodeURIComponent(name)}/auth`, {
      method: 'DELETE',
    })
  },

  async getStatusFor(directory: string): Promise<McpStatusMap> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp`, {
      params: { directory },
    })
  },


  async connectDirectory(name: string, directory: string): Promise<boolean> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp/${encodeURIComponent(name)}/connectdirectory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory }),
    })
  },

  async disconnectDirectory(name: string, directory: string): Promise<boolean> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp/${encodeURIComponent(name)}/disconnectdirectory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory }),
    })
  },

  async authenticateDirectory(name: string, directory: string): Promise<McpStatus> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp/${encodeURIComponent(name)}/authdirectedir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory }),
    })
  },

  async removeAuthDirectory(name: string, directory: string): Promise<{ success: true }> {
    return fetchWrapper(`${API_BASE_URL}/api/settings/mcp/${encodeURIComponent(name)}/authdir`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory }),
    })
  },
}
