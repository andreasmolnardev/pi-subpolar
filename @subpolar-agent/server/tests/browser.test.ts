import { describe, expect, it, vi } from 'vitest'
import { BrowserSessionService, FakeBrowserPort, UnavailableBrowserPort, browserAuditUrl, browserProfileAllows } from '../browser/contracts.ts'

type Row = Record<string, any> & { id: string }
function client(rows: Record<string, Row[]> = {}): any {
  const data = new Map(Object.entries(rows))
  return {
    collection(name: string) {
      const list = () => { const value = data.get(name) ?? []; data.set(name, value); return value }
      return {
        create: async (input: Record<string, unknown>) => { const row = { ...input, id: `${name}-${list().length + 1}` } as Row; list().push(row); return row },
        getOne: async (id: string) => { const row = list().find((item) => item.id === id); if (!row) throw new Error('not found'); return row },
        getFirstListItem: async (filter: string) => { const owner = /user_id = "([^"]*)"/.exec(filter)?.[1]; const session = /session_id = "([^"]*)"/.exec(filter)?.[1]; const row = list().find((item) => (!owner || item.user_id === owner) && (!session || item.session_id === session)); if (!row) throw new Error('not found'); return row },
        getFullList: async () => list(),
        update: async (id: string, input: Record<string, unknown>) => { const row = list().find((item) => item.id === id); if (!row) throw new Error('not found'); Object.assign(row, input); return row },
      }
    },
  }
}

describe('browser session foundation', () => {
  it('keeps read-only profiles out of mutation policy groups', () => {
    expect(browserProfileAllows('navigation', true)).toBe(true)
    expect(browserProfileAllows('submit', true)).toBe(false)
    expect(browserProfileAllows('submit', false)).toBe(true)
  })

  it('enforces owner and lifecycle checks and records redacted actions', async () => {
    const database = client({ browser_audit: [] })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<title>Example</title><p>secret page text</p>'))
    const service = new BrowserSessionService(database, { port: new FakeBrowserPort(fetcher, async () => ['93.184.216.34']), now: () => 10 })
    const session = await service.create({ ownerId: 'alice' })
    await expect(service.get({ ownerId: 'bob' }, session.id)).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' })
    const tab = await service.execute({ ownerId: 'alice' }, 'open', { browserSessionId: session.id, url: 'https://example.com/?token=raw-token#access_token=raw-fragment' }) as { text: string }
    expect(tab.text).toContain('secret page text')
    expect(database.collection('browser_audit').getFullList).toBeDefined()
    const audit = await database.collection('browser_audit').getFullList()
    expect(JSON.stringify(audit)).not.toContain('secret page text')
    expect(JSON.stringify(audit)).not.toContain('raw-token')
    expect(JSON.stringify(audit)).not.toContain('raw-fragment')
    await service.close({ ownerId: 'alice' }, session.id)
    await expect(service.get({ ownerId: 'alice' }, session.id)).rejects.toMatchObject({ code: 'BROWSER_SESSION_CLOSED' })
  })

  it('requires exact bidirectional scope equality for get, list, and operations', async () => {
    const database = client({ browser_sessions: [], browser_audit: [], projects: [{ id: 'project-a', user_id: 'alice' }] })
    const service = new BrowserSessionService(database, { port: new UnavailableBrowserPort() })
    const scoped = await service.create({ ownerId: 'alice', projectId: 'project-a' })
    const unscoped = await service.create({ ownerId: 'alice' })
    await expect(service.get({ ownerId: 'alice' }, scoped.id)).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' })
    await expect(service.get({ ownerId: 'alice', projectId: 'project-a' }, unscoped.id)).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' })
    expect((await service.list({ ownerId: 'alice' })).map((item) => item.id)).toEqual([unscoped.id])
    expect((await service.list({ ownerId: 'alice', projectId: 'project-a' })).map((item) => item.id)).toEqual([scoped.id])
  })

  it('bounds text by UTF-8 bytes without splitting a multibyte character', async () => {
    const database = client({ browser_audit: [] })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<p>A😀éB</p>'))
    const service = new BrowserSessionService(database, { port: new FakeBrowserPort(fetcher), now: () => 10 })
    const session = await service.create({ ownerId: 'alice' }, { maxTextBytes: 6 })
    const tab = await service.execute({ ownerId: 'alice' }, 'open', { browserSessionId: session.id, url: 'https://example.com' }) as { text: string }
    expect(tab.text).toBe('A😀')
    expect(new TextEncoder().encode(tab.text).byteLength).toBeLessThanOrEqual(6)
    expect(() => JSON.stringify(tab)).not.toThrow()
  })

  it('redacts sensitive URL query and fragment parameters', async () => {
    const redacted = browserAuditUrl('https://user:pass@example.com/page?keep=yes&token=raw-token#access_token=raw-fragment&tab=one')
    expect(redacted).toContain('keep=yes')
    expect(redacted).toContain('token=%5BREDACTED%5D')
    expect(redacted).toContain('access_token=%5BREDACTED%5D')
    expect(redacted).not.toContain('raw-token')
    expect(redacted).not.toContain('raw-fragment')
  })

  it('supports fake read/navigation while enforcing private targets, redirects, and limits', async () => {
    const database = client({ browser_audit: [] })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<title>One</title>one'))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
    const service = new BrowserSessionService(database, { port: new FakeBrowserPort(fetcher, async (host) => host === 'example.com' ? ['93.184.216.34'] : ['127.0.0.1']) })
    const session = await service.create({ ownerId: 'alice' }, { maxTabs: 1, maxPageBytes: 1024 })
    const opened = await service.execute({ ownerId: 'alice' }, 'open', { browserSessionId: session.id, url: 'https://example.com' }) as { id: string }
    await expect(service.execute({ ownerId: 'alice' }, 'navigate', { browserSessionId: session.id, tabId: opened.id, url: 'https://example.com/redirect' })).rejects.toMatchObject({ code: 'PRIVATE_HOST' })
    await expect(service.execute({ ownerId: 'alice' }, 'open', { browserSessionId: session.id, url: 'https://example.com/second' })).rejects.toMatchObject({ code: 'BROWSER_LIMIT' })
  })

  it('returns an explicit unsupported-runtime error without a browser engine', async () => {
    const database = client({ browser_audit: [] })
    const service = new BrowserSessionService(database, { port: new UnavailableBrowserPort() })
    const session = await service.create({ ownerId: 'alice' })
    await expect(service.execute({ ownerId: 'alice' }, 'read', { browserSessionId: session.id })).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
  })
})
