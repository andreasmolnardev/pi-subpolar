import {
  DEFAULT_TTS_CONFIG,
  DEFAULT_STT_CONFIG,
  DEFAULT_KEYBOARD_SHORTCUTS,
  DEFAULT_USER_PREFERENCES,
  DEFAULT_INTEGRATION_SETTINGS,
  DEFAULT_LEADER_KEY,
  BLOCKED_SERVER_ENV_KEYS,
  DEFAULT_SERVER_ENV_VARS,
  type TTSConfig,
  type STTConfig,
  type OpenCodeConfigContent,
  type ModelConfig,
  type ProviderConfig,
  type IntegrationConfig,
  type IntegrationSettings,
  type DefaultModels,
  type SkillFileInfo,
  type CreateSkillRequest,
  type UpdateSkillRequest,
  type SkillScope,
  type AgentDefinition,
} from '@subpolar/shared'
import type { NotificationPreferences } from '@subpolar/shared/types'

export type { TTSConfig, STTConfig, OpenCodeConfigContent, ModelConfig, ProviderConfig, NotificationPreferences, SkillFileInfo, CreateSkillRequest, UpdateSkillRequest, SkillScope, IntegrationConfig, IntegrationSettings, DefaultModels, AgentDefinition }
export { DEFAULT_TTS_CONFIG, DEFAULT_STT_CONFIG, DEFAULT_KEYBOARD_SHORTCUTS, DEFAULT_USER_PREFERENCES, DEFAULT_LEADER_KEY, BLOCKED_SERVER_ENV_KEYS, DEFAULT_SERVER_ENV_VARS, DEFAULT_INTEGRATION_SETTINGS }

export interface CustomCommand {
  name: string
  description: string
  promptTemplate: string
}

export interface GitCredential {
  name: string
  host: string
  type: 'pat' | 'ssh'
  token?: string
  sshPrivateKey?: string
  sshPrivateKeyEncrypted?: string
  hasPassphrase?: boolean
  username?: string
  passphrase?: string
}

export interface GitIdentity {
  name: string
  email: string
}

export interface UserPreferences {
  theme: string
  mode: 'plan' | 'build'
  defaultModel?: string
  defaultModels?: DefaultModels
  defaultAgent?: string
  autoScroll: boolean
  expandDiffs: boolean
  expandToolCalls: boolean
  showReasoning: boolean
  simpleChatMode: boolean
  hiddenSidebarAgents?: string[]
  hiddenChatInputAgents?: string[]
  leaderKey?: string
  directShortcuts?: string[]
  keyboardShortcuts: Record<string, string>
  customCommands: CustomCommand[]
  gitCredentials?: GitCredential[]
  gitIdentity?: GitIdentity
  tts?: TTSConfig
  stt?: STTConfig
  notifications?: NotificationPreferences
  integrations?: IntegrationSettings
  repoOrder?: number[]
  repoSortMode?: 'recent' | 'manual' | 'name'
  serverEnvVars?: Array<{ key: string; value: string }>
  disabledDefaultServerEnvVars?: string[]
}

export interface SettingsResponse {
  preferences: UserPreferences
  updatedAt: number
  serverRestarted?: boolean
  reloadError?: string
}

export interface UpdateSettingsRequest {
  preferences: Partial<UserPreferences>
}

export interface PiConfig {
  id: number
  name: string
  content: Record<string, unknown>
  rawContent?: string
  validationIssues?: Array<{
    path: string
    message: string
  }>
  removedFields?: string[]
  isValid: boolean
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface CreatePiConfigRequest {
  name: string
  content: OpenCodeConfigContent | string
  isDefault?: boolean
}

export interface UpdatePiConfigRequest {
  content: OpenCodeConfigContent | string
  isDefault?: boolean
}

export interface PiConfigResponse {
  configs: PiConfig[]
  defaultConfig: PiConfig | null
}

export interface PiImportStatus {
  configSourcePath: string | null
  stateSourcePath: string | null
  workspaceConfigPath: string
  workspaceStatePath: string
  workspaceStateExists: boolean
}

export interface SyncPiImportResponse extends PiImportStatus {
  success: boolean
  message: string
  serverRestarted: boolean
  configImported: boolean
  stateImported: boolean
  relinkedRepos?: {
    repos: Array<Record<string, unknown>>
    relinkedCount: number
    existingCount: number
    nonRepoPathCount: number
    duplicatePathCount: number
    errors: Array<{ path: string; error: string }>
  }
}
