export const GENERAL_CHAT_PROJECT_ID = 0

export const DEFAULT_TTS_CONFIG = {
  enabled: false,
  provider: 'external',
  autoPlay: false,
  endpoint: 'https://api.openai.com',
  apiKey: '',
  voice: 'alloy',
  model: 'tts-1',
  speed: 1,
  availableVoices: [],
  availableModels: [],
  lastVoicesFetch: 0,
  lastModelsFetch: 0,
}

export const DEFAULT_STT_CONFIG = {
  enabled: false,
  provider: 'builtin',
  endpoint: 'https://api.openai.com',
  apiKey: '',
  model: '',
  language: 'en-US',
  availableModels: [],
  lastModelsFetch: 0,
}

export const DEFAULT_KEYBOARD_SHORTCUTS: Record<string, string> = {
  submit: 'Cmd+Enter',
  abort: 'Escape',
  toggleMode: 'T',
  undo: 'Z',
  redo: 'Shift+Z',
  compact: 'K',
  fork: 'F',
  settings: ',',
  sessions: 'S',
  newSession: 'N',
  closeSession: 'W',
  toggleSidebar: 'B',
  selectModel: 'M',
  variantCycle: 'Cmd+T',
}

export const DEFAULT_LEADER_KEY = 'Cmd+O'
export const DEFAULT_INTEGRATION_SETTINGS: unknown[] = []
export const DEFAULT_NOTIFICATION_PREFERENCES = {
  enabled: false,
  events: { permissionAsked: true, questionAsked: true, sessionError: true, sessionIdle: false },
}
export const DEFAULT_SERVER_ENV_VARS: Array<{ key: string; value: string }> = []
export const BLOCKED_SERVER_ENV_KEYS: string[] = []
export const DEFAULT_USER_PREFERENCES = {
  theme: 'dark',
  mode: 'build',
  autoScroll: true,
  expandDiffs: true,
  expandToolCalls: false,
  showReasoning: false,
  simpleChatMode: false,
  defaultModels: {},
  hiddenSidebarAgents: ['auto', 'compaction', 'summary', 'title'],
  hiddenChatInputAgents: ['compaction', 'summary', 'title'],
  leaderKey: DEFAULT_LEADER_KEY,
  directShortcuts: ['submit', 'abort'],
  keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
  customCommands: [],
  gitCredentials: [],
  gitIdentity: { name: 'Pi Agent', email: '' },
  tts: DEFAULT_TTS_CONFIG,
  stt: DEFAULT_STT_CONFIG,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
  integrations: DEFAULT_INTEGRATION_SETTINGS,
  repoSortMode: 'recent',
  serverEnvVars: [],
  disabledDefaultServerEnvVars: [],
}

export const DEFAULTS = {
  SERVER: { PORT: 4173 },
  FILE_LIMITS: { MAX_SIZE_MB: 50, MAX_UPLOAD_SIZE_MB: 50 },
  SSE: { RECONNECT_DELAY_MS: 1000, MAX_RECONNECT_DELAY_MS: 30000, STALL_THRESHOLD_MS: 90000, WATCHDOG_TICK_MS: 15000 },
} as const

export const ALLOWED_MIME_TYPES = ['text/plain', 'text/html', 'text/css', 'text/javascript', 'text/typescript', 'application/json', 'application/xml', 'image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'application/pdf', 'application/zip', 'text/markdown'] as const
export const GIT_PROVIDERS = { GITHUB: 'github.com', GITLAB: 'gitlab.com', BITBUCKET: 'bitbucket.org' } as const

export function parseJsonc<T = unknown>(source: string): T {
  return JSON.parse(source) as T
}

export function getPermissionLabel(permission: string): string {
  if (!permission) return 'Approval'
  return permission.charAt(0).toUpperCase() + permission.slice(1)
}

export function getPermissionDetail(input: { permission?: unknown; metadata?: unknown; patterns?: unknown }) {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata as Record<string, unknown> : {}
  const primary = typeof metadata.command === 'string'
    ? metadata.command
    : typeof metadata.filePath === 'string'
      ? metadata.filePath
      : Array.isArray(input.patterns) ? input.patterns.filter((value): value is string => typeof value === 'string').join('\n') : ''
  return { primary, secondary: undefined as string | undefined }
}

export function getQuestionText(input: { questions?: unknown }): string {
  const first = Array.isArray(input.questions) ? input.questions[0] : undefined
  return first && typeof first === 'object' && typeof (first as { question?: unknown }).question === 'string'
    ? (first as { question: string }).question
    : ''
}

// Type-only compatibility surface for source components that remain cloned but are not Pi-backed.
export type AgentSkillAccess = any
export type SkillFileInfo = any
export type TTSConfig = any
export type STTConfig = any
export type OpenCodeConfigContent = any
export type OpenCodeConfigInput = any
export type ModelConfig = any
export type ProviderConfig = any
export type IntegrationConfig = any
export type IntegrationSettings = any
export type DefaultModels = any
export type AgentDefinition = any
export type SkillDiscoveryMode = any
export type CreateSkillRequest = any
export type UpdateSkillRequest = any
export type SkillScope = any
export type GeneralChatStatus = any
export type GeneralChatInitRequest = any
export type NotificationPreferences = any
export type PushSubscriptionRecord = any
export type CreateAutomationJobRequest = any
export type UpdateAutomationJobRequest = any
export type AutomationJob = any
export type AutomationRun = any
export type PromptTemplate = any
export type CreatePromptTemplateRequest = any
export type UpdatePromptTemplateRequest = any
export type SSEEventEnvelope = any
