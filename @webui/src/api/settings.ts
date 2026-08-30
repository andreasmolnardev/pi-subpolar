import type {
  SettingsResponse, 
  UpdateSettingsRequest, 
  PiConfig,
  PiConfigResponse,
  CreatePiConfigRequest,
  UpdatePiConfigRequest,
  PiImportStatus,
  SyncPiImportResponse,
  SkillFileInfo,
  CreateSkillRequest,
  UpdateSkillRequest,
  AgentDefinition,
  SkillScope,
  IntegrationConfig,
  IntegrationSettings,
} from './types/settings'
import { API_BASE_URL } from '@/config'
import { fetchWrapper, FetchError } from './fetchWrapper'

const DEFAULT_USER_ID = 'default'

export const settingsApi = {
  listAgents: async (): Promise<AgentDefinition[]> => fetchWrapper(`${API_BASE_URL}/api/agents`),

  createAgent: async (agent: Omit<AgentDefinition, 'id' | 'created_at' | 'updated_at' | 'source'>): Promise<AgentDefinition> => fetchWrapper(`${API_BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  }),

  updateAgent: async (identifier: string, agent: Partial<Omit<AgentDefinition, 'id' | 'created_at' | 'updated_at' | 'source'>>): Promise<AgentDefinition> => fetchWrapper(`${API_BASE_URL}/api/agents/${encodeURIComponent(identifier)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  }),

  deleteAgent: async (identifier: string): Promise<{ success: boolean }> => fetchWrapper(`${API_BASE_URL}/api/agents/${encodeURIComponent(identifier)}`, {
    method: 'DELETE',
  }),

  getSettings: async (userId = DEFAULT_USER_ID): Promise<SettingsResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings`, {
      params: { userId },
    })
  },

  updateSettings: async (
    updates: UpdateSettingsRequest,
    userId = DEFAULT_USER_ID
  ): Promise<SettingsResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings`, {
      method: 'PATCH',
      params: { userId },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
  },

  resetSettings: async (userId = DEFAULT_USER_ID): Promise<SettingsResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings`, {
      method: 'DELETE',
      params: { userId },
    })
  },

  listIntegrations: async (): Promise<{ integrations: IntegrationSettings }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/integrations`)
  },

  createIntegration: async (integration: IntegrationConfig): Promise<IntegrationConfig> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/integrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(integration),
    })
  },

  updateIntegration: async (integration: IntegrationConfig): Promise<IntegrationConfig> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/integrations/${encodeURIComponent(integration.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(integration),
    })
  },

  deleteIntegration: async (id: string): Promise<{ success: boolean }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/integrations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  getUpcomingCalendarEvents: async (): Promise<{
    calendars: Array<{ id: string; name: string; url: string }>
    events: Array<{ title: string; calendar: string; start: string; end: string | null; location?: string }>
  }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/calendar/upcoming`)
  },

  getPiConfigs: async (userId = DEFAULT_USER_ID): Promise<PiConfigResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/pi-settings`, {
      params: { userId },
    })
  },

  createPiConfig: async (
    request: CreatePiConfigRequest,
    userId = DEFAULT_USER_ID
  ): Promise<PiConfig> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/pi-settings`, {
      method: 'POST',
      params: { userId },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  },

  updatePiConfig: async (
    configName: string,
    request: UpdatePiConfigRequest,
    userId = DEFAULT_USER_ID
  ): Promise<PiConfig> => {
    return fetchWrapper(
      `${API_BASE_URL}/api/settings/pi-settings/${encodeURIComponent(configName)}`,
      {
        method: 'PUT',
        params: { userId },
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }
    )
  },

  deletePiConfig: async (
    configName: string,
    userId = DEFAULT_USER_ID
  ): Promise<boolean> => {
    await fetchWrapper(
      `${API_BASE_URL}/api/settings/pi-settings/${encodeURIComponent(configName)}`,
      {
        method: 'DELETE',
        params: { userId },
      }
    )
    return true
  },

  setDefaultPiConfig: async (
    configName: string,
    userId = DEFAULT_USER_ID
  ): Promise<PiConfig> => {
    return fetchWrapper(
      `${API_BASE_URL}/api/settings/pi-settings/${encodeURIComponent(configName)}/set-default`,
      {
        method: 'POST',
        params: { userId },
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    )
  },

  getDefaultPiConfig: async (userId = DEFAULT_USER_ID): Promise<PiConfig | null> => {
    try {
      return fetchWrapper(`${API_BASE_URL}/api/settings/pi-settings/default`, {
        params: { userId },
      })
    } catch {
      return null
    }
  },

  restartServer: async (): Promise<{ success: boolean; message: string; details?: string }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/pi-restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  },

  reloadConfig: async (): Promise<{ success: boolean; message: string; details?: string }> => {
    try {
      return fetchWrapper(`${API_BASE_URL}/api/settings/pi-reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      if (error instanceof FetchError && error.statusCode === 404) {
        return fetchWrapper(`${API_BASE_URL}/api/settings/pi-restart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw error
    }
  },

  rollbackConfig: async (): Promise<{ success: boolean; message: string; configName?: string }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/pi-rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  },

  getPiImportStatus: async (): Promise<PiImportStatus> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/pi-import/status`)
  },

  syncPiImport: async (overwriteState = false): Promise<SyncPiImportResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/pi-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overwriteState }),
    })
  },

  getPiVersions: async (): Promise<{
    versions: Array<{
      version: string
      tag: string
      name: string
      publishedAt: string
    }>
    currentVersion: string | null
  }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/pi-versions`)
  },

  installPiVersion: async (version: string): Promise<{
    success: boolean
    message: string
    oldVersion?: string
    newVersion?: string
    recovered?: boolean
    recoveryMessage?: string
  }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/pi-install-version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    })
  },

  upgradePi: async (): Promise<{
    success: boolean
    message: string
    oldVersion?: string
    newVersion?: string
    upgraded: boolean
    recovered?: boolean
    recoveryMessage?: string
  }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/pi-upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  },

  testSSHConnection: async (host: string, sshPrivateKey: string, passphrase?: string): Promise<{ success: boolean; message: string }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/test-ssh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, sshPrivateKey, passphrase }),
    })
  },

  discoverCalDavCalendars: async (serverUrl: string, username: string, password: string): Promise<{ calendars: Array<{ name: string; url: string; description?: string }> }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/discover-caldav-calendars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, username, password }),
    })
  },

  getAgentsMd: async (): Promise<{ content: string }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/agents-md`)
  },

  getDefaultAgentsMd: async (): Promise<{ content: string }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/agents-md/default`)
  },

  updateAgentsMd: async (content: string): Promise<{ success: boolean }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/agents-md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  },

  listSubpolarTools: async (): Promise<{ tools: SubpolarTool[] }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/subpolar-tools`)
  },

  discoverOpenApi: async (integration: IntegrationConfig & { type: 'openapi' }): Promise<{ providerName: string; tools: Array<{ toolId: string; method: string; path: string; description: string }> }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/openapi/discover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(integration) })
  },

  listAgentToolPolicies: async (agentId: string): Promise<{ policies: AgentToolPolicy[] }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/agents/${encodeURIComponent(agentId)}/tool-policies`)
  },

  replaceAgentToolPolicies: async (agentId: string, policies: Array<{ toolId: string; effect: AgentToolPolicyEffect }>): Promise<{ policies: AgentToolPolicy[] }> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/agents/${encodeURIComponent(agentId)}/tool-policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies }),
    })
  },

  getVersionInfo: async (): Promise<VersionInfo> => {
    return fetchWrapper(`${API_BASE_URL}/api/health/version`)
  },

  listManagedSkills: async (repoId?: number, directory?: string): Promise<SkillFileInfo[]> => {
    const searchParams = new URLSearchParams()
    if (repoId) searchParams.set('repoId', String(repoId))
    if (directory) searchParams.set('directory', directory)
    const query = searchParams.toString() ? `?${searchParams.toString()}` : ''
    return fetchWrapper(`${API_BASE_URL}/api/settings/skills${query}`)
  },

  getSkill: async (name: string, scope: SkillScope, repoId?: number): Promise<SkillFileInfo> => {
    const params = new URLSearchParams({ scope })
    if (repoId) params.set('repoId', String(repoId))
    return fetchWrapper(`${API_BASE_URL}/api/settings/skills/${name}?${params}`)
  },

  createSkill: async (data: CreateSkillRequest): Promise<SkillFileInfo> => {
    return fetchWrapper(`${API_BASE_URL}/api/settings/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  updateSkill: async (name: string, scope: SkillScope, data: UpdateSkillRequest, repoId?: number): Promise<SkillFileInfo> => {
    const params = new URLSearchParams({ scope })
    if (repoId) params.set('repoId', String(repoId))
    return fetchWrapper(`${API_BASE_URL}/api/settings/skills/${name}?${params}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  deleteSkill: async (name: string, scope: SkillScope, repoId?: number): Promise<{ success: boolean }> => {
    const params = new URLSearchParams({ scope })
    if (repoId) params.set('repoId', String(repoId))
    return fetchWrapper(`${API_BASE_URL}/api/settings/skills/${name}?${params}`, {
      method: 'DELETE',
    })
  },
}

export interface VersionInfo {
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  releaseUrl: string | null
  releaseName: string | null
}

export type AgentToolPolicyEffect = 'allow' | 'deny' | 'approval'

export interface SubpolarTool {
  tool_id: string
  namespace: string
  adapter?: 'internal' | 'mcp' | 'openapi' | 'http' | 'custom'
  description: string
  input_schema?: Record<string, unknown>
  risk: 'read' | 'write' | 'delete' | 'external'
  requires_approval: boolean
  metadata?: Record<string, unknown>
}

export interface AgentToolPolicy {
  id?: string
  agent_id: string
  tool_id: string
  effect: AgentToolPolicyEffect
}

export interface ManagerTokenResponse {
  token: string
}

export async function getManagerToken(): Promise<ManagerTokenResponse> {
  return fetchWrapper(`${API_BASE_URL}/api/settings/manager-token`)
}

export async function rotateManagerToken(): Promise<ManagerTokenResponse> {
  return fetchWrapper(`${API_BASE_URL}/api/settings/manager-token/rotate`, {
    method: 'POST',
  })
}
