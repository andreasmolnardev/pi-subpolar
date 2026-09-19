export type VoiceProvider = 'local' | 'browser' | 'cloud'

export interface VoiceBackendStatus {
  available: boolean
  kind: VoiceProvider
  name: string
  detail?: string
}

export function isVoiceProviderConfigured(
  provider: VoiceProvider,
  config: { enabled: boolean; apiKey?: string; apiKeyRef?: string },
  browserSupported = true,
): boolean {
  if (!config.enabled) return false
  if (provider === 'browser') return browserSupported
  if (provider === 'cloud') return Boolean(config.apiKey?.trim() || config.apiKeyRef?.trim())
  return true
}

export function redactVoiceSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const input = value as Record<string, unknown>
  const output = { ...input }
  delete output.apiKey
  delete output.token
  delete output.secret

  if (typeof output.apiKeyRef !== 'string' || !output.apiKeyRef.trim()) {
    delete output.apiKeyRef
  }

  return output
}
