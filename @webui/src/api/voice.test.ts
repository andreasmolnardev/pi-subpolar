import { describe, expect, it } from 'vitest'
import { isVoiceProviderConfigured, redactVoiceSettings } from './voice'

describe('voice provider configuration', () => {
  it('allows an enabled local provider without browser credentials', () => {
    expect(isVoiceProviderConfigured('local', { enabled: true })).toBe(true)
  })

  it('treats a protected API key reference as configured', () => {
    expect(isVoiceProviderConfigured('cloud', { enabled: true, apiKeyRef: 'vault://tts' })).toBe(true)
    expect(isVoiceProviderConfigured('cloud', { enabled: true })).toBe(false)
  })

  it('keeps disabled providers unavailable and redacts secret values', () => {
    expect(isVoiceProviderConfigured('local', { enabled: false })).toBe(false)
    expect(redactVoiceSettings({ apiKey: 'secret', token: 'token', apiKeyRef: 'vault://tts' })).toEqual({ apiKeyRef: 'vault://tts' })
  })
})
