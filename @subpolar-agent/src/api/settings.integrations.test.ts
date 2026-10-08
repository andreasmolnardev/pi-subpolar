import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from './settings'

describe('settingsApi web search integration defaults', () => {
  let preferences: Record<string, unknown>

  beforeEach(() => {
    preferences = { integrations: [] }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { preferences?: Record<string, unknown> }
        preferences = { ...preferences, ...body.preferences }
      }
      return Response.json({ preferences, updatedAt: 1 })
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('provides keyless Exa and Firecrawl defaults and persists provider choices in user preferences', async () => {
    const initial = await settingsApi.listIntegrations()
    expect(initial.integrations).toContainEqual(expect.objectContaining({
      id: 'web-search',
      type: 'web-search',
      enabled: true,
      providers: ['exa', 'firecrawl'],
    }))

    const updated = { ...initial.integrations[0], providers: ['firecrawl'] } as never
    await settingsApi.updateIntegration(updated)

    const reloaded = await settingsApi.listIntegrations()
    expect(reloaded.integrations).toContainEqual(expect.objectContaining({ type: 'web-search', providers: ['firecrawl'] }))
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/settings'), expect.objectContaining({ method: 'PATCH' }))
  })
})
