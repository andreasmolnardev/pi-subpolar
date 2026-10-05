import { describe, expect, it } from 'bun:test'
import { handleSettingsRoute } from '../routes/settings.ts'

function setup(method: 'GET' | 'PATCH', initial: Record<string, unknown>, body: Record<string, unknown> = {}) {
  let preferences = structuredClone(initial)
  const saved: Record<string, unknown>[] = []
  const record = () => ({ id: 'pref-1', user_id: 'owner-a', preferences: structuredClone(preferences), updated_at: 123 })
  const url = new URL('http://localhost/api/settings')
  const route = handleSettingsRoute({
    request: new Request(url.href, { method }), url, path: ['api', 'settings'], correlationId: 'settings-test',
    authenticatedUser: { id: 'owner-a' }, gatewayCredential: null, internalRequest: false,
    deps: {
      DEFAULT_SETTINGS: { theme: 'dark', gitIdentity: { name: 'Pi Agent', email: '' }, tts: null, stt: null },
      applicationDatabase: async () => ({}),
      getUserPreferences: async () => record(),
      saveUserPreferences: async (_client: unknown, _owner: string, next: Record<string, unknown>) => {
        preferences = structuredClone(next)
        saved.push(structuredClone(next))
        return { ...record(), preferences: structuredClone(next), updated_at: 124 }
      },
      body: async () => ({ preferences: body }),
      object: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
      redactVoiceSettings: (value: unknown) => value,
      redactedDiagnostic: () => '[redacted]',
      json: (value: unknown, status = 200) => Response.json(value, { status }),
    },
  } as never)
  return { route, saved, current: () => preferences }
}

describe('legacy Git settings scrubbing', () => {
  it('keeps legacy credentials as migration input while hiding them from settings GET', async () => {
    const f = setup('GET', {
      gitIdentity: { name: 'Safe Name', email: 'safe@example.test' },
      gitCredentials: [{ type: 'ssh', sshPrivateKey: 'private-key-must-not-escape', passphrase: 'secret-passphrase' }],
    })
    const response = await f.route
    const output = await response!.text()
    expect(response!.status).toBe(200)
    expect(output).not.toContain('private-key-must-not-escape')
    expect(output).not.toContain('secret-passphrase')
    expect(f.saved).toHaveLength(0)
    expect(f.current().gitCredentials).toEqual([{ type: 'ssh', sshPrivateKey: 'private-key-must-not-escape', passphrase: 'secret-passphrase' }])
  })

  it('preserves migration input and rejects submitted legacy credentials through PATCH', async () => {
    const f = setup('PATCH', { theme: 'dark', gitCredentials: [{ type: 'pat', token: 'legacy-token' }] }, {
      gitCredentials: [{ type: 'pat', token: 'new-token' }], gitIdentity: { name: 'Commit Author', email: 'author@example.test' },
    })
    const response = await f.route
    const output = await response!.text()
    expect(response!.status).toBe(200)
    expect(output).not.toContain('legacy-token')
    expect(output).not.toContain('new-token')
    expect(f.current().gitCredentials).toEqual([{ type: 'pat', token: 'legacy-token' }])
    expect(f.current()).toMatchObject({ gitIdentity: { name: 'Commit Author', email: 'author@example.test' } })
  })
})
