import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from './settings'

describe('settingsApi shared tool client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists registered tools through the shared client and keeps the wrapped response shape', async () => {
    const tools = [{ tool_id: 'builtin/read', namespace: 'builtin', description: 'Read', input_schema: {}, risk: 'read', requires_approval: false }]
    const fetchMock = vi.fn(async () => Response.json({ tools }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(settingsApi.listSubpolarTools()).resolves.toEqual({ tools })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(input).pathname).toBe('/api/settings/subpolar-tools')
    expect(init.credentials).toBe('include')
    expect(init.cache).toBe('no-store')
  })

  it('lists agent policies through the shared client and keeps the wrapped response shape', async () => {
    const policies = [{ id: 'policy-1', agent_id: 'agent/one', toolId: 'builtin/read', tool_id: 'builtin/read', effect: 'allow' }]
    const fetchMock = vi.fn(async () => Response.json({ policies }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(settingsApi.listAgentToolPolicies('agent/one')).resolves.toEqual({ policies })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(input).pathname).toBe('/api/settings/agents/agent%2Fone/tool-policies')
    expect(init.credentials).toBe('include')
    expect(init.cache).toBe('no-store')
  })

  it('replaces agent policies through the shared client with the existing request semantics', async () => {
    const inputPolicies = [{ toolId: 'builtin/read', effect: 'allow' as const }]
    const policies = [{ id: 'policy-1', agent_id: 'agent/one', toolId: 'builtin/read', tool_id: 'builtin/read', effect: 'allow' }]
    const fetchMock = vi.fn(async () => Response.json({ policies }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(settingsApi.replaceAgentToolPolicies('agent/one', inputPolicies)).resolves.toEqual({ policies })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(input).pathname).toBe('/api/settings/agents/agent%2Fone/tool-policies')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ policies: inputPolicies })
    expect(init.credentials).toBe('include')
    expect(init.cache).toBe('no-store')
  })
})
