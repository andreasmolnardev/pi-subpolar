import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectSessionRepository, ownerProjectDirectory } from '../persistence/project-store.ts'
import { configuredWorkspaceRoot, canonicalProjectPath, isPathWithin, assertPathWithinWorkspace } from '../core/project-filesystem.ts'
import { SessionTranscriptRepository } from '../persistence/session-transcript.ts'
import { PocketBaseRuntimeStore } from '../persistence/pocketbase-runtime-store.ts'
import { getUserPreferences, saveUserPreferences } from '../persistence/pocketbase.ts'
import { PocketBaseProxyCredentialStore, hashProxySecret, proxyCredentialResponse } from '../persistence/pocketbase-proxy-credentials.ts'
import { createGatewayCredential, listGatewayCredentials, publicGatewayCredential, revokeGatewayCredential, authenticateGatewayCredential } from '../persistence/gateway-credentials.ts'
import { ProviderAccountService } from '../persistence/provider-accounts.ts'
import { BrowserSessionService, FakeBrowserPort } from '../browser/contracts.ts'
import { SessionWorkspaceService } from '../application/session-workspace.ts'
import { handleProjectsRoute } from '../routes/projects.ts'
import { handleSettingsRoute } from '../routes/settings.ts'
import { handleAgentsRoute } from '../routes/agents.ts'
import { handleTasksRoute } from '../routes/tasks.ts'
import { handleBrowserRoute } from '../routes/browser.ts'

// Intentionally ignores ALL filters, including first-item filters. Foreign rows
// precede owned rows; safety must not depend on the mock implementing PB rules.
type Row = Record<string, any> & { id: string }
function unfiltered(initial: Record<string, Row[]> = {}) {
  const rows = initial
  const writes: Array<{ name: string; id: string; operation: string }> = []
  const client: any = { collection(name: string) {
    const list = () => rows[name] ??= []
    return {
      getFullList: async () => list(),
      getFirstListItem: async () => { if (!list()[0]) throw { status: 404 }; return list()[0] },
      getOne: async (id: string) => { const row = list().find(row => row.id === id); if (!row) throw { status: 404 }; return row },
      create: async (input: Record<string, unknown>) => { const row = { ...input, id: `${name}-${list().length + 1}` } as Row; list().push(row); writes.push({ name, id: row.id, operation: 'create' }); return row },
      update: async (id: string, input: Record<string, unknown>) => { const row = list().find(row => row.id === id); if (!row) throw { status: 404 }; Object.assign(row, input); writes.push({ name, id, operation: 'update' }); return row },
      delete: async (id: string) => { writes.push({ name, id, operation: 'delete' }); rows[name] = list().filter(row => row.id !== id); return true },
    }
  } }
  return { client, rows, writes }
}
function routeContext(path: string, deps: Record<string, unknown>, method = 'GET', input?: unknown): any {
  const url = new URL(`http://localhost${path}`)
  return { request: new Request(url.href, { method, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), url, path: url.pathname.split('/').filter(Boolean), authenticatedUser: { id: 'alice' }, deps: {
    json: (value: unknown, status = 200) => Response.json(value, { status }),
    body: (request: Request) => request.json(), object: (value: unknown) => value ?? {},
    redactedDiagnostic: () => 'redacted', ...deps,
  } }
}
const project = (id: string, owner: string, path: string): Row => ({ id, user_id: owner, name: id, path, created_at: 1, updated_at: 1 })

describe('multi-user storage boundaries with an unfiltered transport', () => {
  it('fences project/session lookups, listings, updates and deletes', async () => {
    const root = configuredWorkspaceRoot()
    const db = unfiltered({ projects: [project('foreign', 'bob', join(root, 'bob')), project('own', 'alice', join(root, 'alice'))], sessions: [
      { id: 'foreign-session', user_id: 'bob', session_id: 'same', project_name: 'foreign', title: 'bob-private', created_at: 1, updated_at: 1 },
      { id: 'own-session', user_id: 'alice', session_id: 'mine', project_name: 'own', title: 'alice', created_at: 1, updated_at: 1 },
    ] })
    const repo = new ProjectSessionRepository(db.client)
    expect(await repo.getProject('alice', 'foreign')).toBeNull()
    expect(await repo.findProjectByName('alice', 'foreign')).toBeNull()
    expect((await repo.listProjects('alice')).map(row => row.id)).toEqual(['own'])
    expect(await repo.getSession('alice', 'same')).toBeNull()
    expect((await repo.listSessions('alice')).map(row => row.id)).toEqual(['mine'])
    expect(await repo.updateProject('alice', 'foreign', { name: 'changed' })).toBeNull()
    expect(await repo.deleteSession('alice', 'same')).toBe(false)
    expect(db.writes).toEqual([])
    await expect(repo.createSession('alice', { id: 'new', project: 'General Chat', directory: join(root, 'bob') })).rejects.toThrow()
    await expect(repo.assertProjectPathAvailable('alice', root)).rejects.toThrow()
    await expect(repo.assertProjectPathAvailable('alice', join(root, 'workspace-review'))).rejects.toThrow()
    await expect(repo.assertProjectPathAvailable('alice', join(root, '.ssh'))).rejects.toThrow()
    expect(ownerProjectDirectory('alice', 'Demo')).not.toBe(ownerProjectDirectory('bob', 'Demo'))
    await expect(repo.assertProjectPathAvailable('alice', ownerProjectDirectory('bob', 'unclaimed'))).rejects.toThrow()
    await expect(repo.assertProjectPathAvailable('alice', join(root, 'worktrees', 'bob', 'unclaimed'))).rejects.toThrow()
  })

  it('retains server-allocated General Chat roots but rejects parent, wrong-session and cross-owner reuse', async () => {
    const root = configuredWorkspaceRoot()
    const db = unfiltered()
    const repo = new ProjectSessionRepository(db.client)
    await repo.createSession('alice', { id: 'same', project: 'General Chat', directory: join(root, 'general-chat', 'same') })
    await expect(repo.createSession('bob', { id: 'same', project: 'General Chat', directory: join(root, 'general-chat', 'same') })).rejects.toThrow()
    await expect(repo.createSession('bob', { id: 'other', project: 'General Chat', directory: join(root, 'general-chat', 'same') })).rejects.toThrow()
    await expect(repo.createSession('bob', { id: 'other', project: 'General Chat', directory: join(root, 'general-chat') })).rejects.toThrow()
    await repo.createSession('bob', { id: 'other', project: 'General Chat', directory: join(root, 'general-chat', 'other') })
    expect((await repo.listSessions('bob')).map(row => row.id)).toEqual(['other'])
    db.rows.sessions!.push({ id: 'legacy-duplicate', user_id: 'bob', session_id: 'same' })
    expect(await repo.getSessionById('same')).toBeNull()
  })

  it('fences transcript, preferences, recovery, queue and event projections and mutations', async () => {
    const db = unfiltered({
      session_transcripts: [{ id: 'foreign', owner_id: 'bob', session_id: 'same', entries: ['bob-private'] }, { id: 'own', owner_id: 'alice', session_id: 'same', entries: ['alice'] }],
      user_preferences: [{ id: 'foreign', user_id: 'bob', preferences: { private: 'bob-private' } }],
      message_deliveries: [{ id: 'foreign', owner_id: 'bob', session_id: 'same', message_id: 'same', state: 'pending', content: 'bob-private' }],
      message_queue: [{ id: 'foreign', owner_id: 'bob', session_id: 'same', client_id: 'same', state: 'enqueued', kind: 'follow_up', content: 'bob-private' }],
      runtime_runs: [{ id: 'foreign', owner_id: 'bob', session_id: 'same', run_id: 'same', state: 'running' }],
      durable_events: [{ id: 'foreign', owner_id: 'bob', cursor: 1, payload: 'bob-private' }, { id: 'own', owner_id: 'alice', cursor: 2, payload: 'alice', type: 'message', occurred_at: 1 }],
    })
    const transcripts = new SessionTranscriptRepository(db.client)
    expect(await transcripts.get('alice', 'same')).toBeNull()
    expect((await transcripts.list('alice')).map(row => row.entries)).toEqual([['alice']])
    expect(await getUserPreferences(db.client, 'alice')).toBeNull()
    await saveUserPreferences(db.client, 'alice', { private: 'alice' })
    expect(db.rows.user_preferences![0]!.preferences.private).toBe('bob-private')
    const runtime = new PocketBaseRuntimeStore(db.client)
    expect(await runtime.getMessageDelivery('alice', 'same', 'same')).toBeNull()
    expect(await runtime.getLatestPendingMessageDelivery('alice', 'same')).toBeNull()
    expect(await runtime.listQueueEntries('alice', 'same')).toEqual([])
    expect(await runtime.claimQueueEntry('alice', 'same', 'same')).toBeNull()
    expect(await runtime.updateRuntimeRun('alice', 'same', 'same', 'completed')).toBeNull()
    await runtime.clearQueue('alice', 'same')
    const replay = await runtime.replayEvents('alice', '0')
    expect(replay.events.map(row => row.payload)).toEqual(['alice'])
    expect(db.writes.filter(row => row.id === 'foreign')).toEqual([])
  })

  it('fences proxy secret authentication and revocation; whitelists credential projections', async () => {
    const db = unfiltered({ proxy_credentials: [{ id: 'foreign', owner_id: 'bob', credential_id: 'same', prefix: 'bob', secret_hash: hashProxySecret('bob-secret'), created_at: 1 }] })
    const store = new PocketBaseProxyCredentialStore(db.client)
    expect(await store.list('alice')).toEqual([])
    expect(await store.authenticate('alice-secret')).toBeNull()
    expect(await store.revoke('alice', 'same')).toBe(false)
    expect(await store.authenticate('bob-secret')).toMatchObject({ ownerId: 'bob' })
    expect(JSON.stringify(proxyCredentialResponse((await store.list('bob'))[0]!))).not.toContain('hash')
    const foreign = await createGatewayCredential(db.client, { ownerId: 'bob', principal: 'bob', permissions: ['list'] })
    expect(await listGatewayCredentials(db.client, 'alice')).toEqual([])
    expect(await revokeGatewayCredential(db.client, 'alice', foreign.credential.id)).toBe(false)
    await expect(authenticateGatewayCredential(db.client, 'subpolar_gw_wrong')).rejects.toThrow()
    expect(JSON.stringify(publicGatewayCredential({ ...foreign.credential, secret_hash: 'never-project', secret: 'never-project' } as any))).not.toContain('never-project')
  })

  it('rejects decrypting a foreign provider envelope even when both collection queries ignore owners (read-only module)', async () => {
    const db = unfiltered()
    const providers = new ProviderAccountService(db.client, { encryptionKey: new Uint8Array(32).fill(7), instanceId: () => 'bob-account' })
    await providers.createAccount('bob', { providerType: 'openai', displayName: 'Bob', authType: 'api_key', credential: { type: 'api_key', key: 'bob-secret' } })
    await expect(providers.loadCredential('alice', 'bob-account')).resolves.toBeNull()
    expect(db.writes.filter(row => row.operation === 'update')).toEqual([])
    const status = await providers.getAccountStatus('bob', 'bob-account')
    expect(JSON.stringify(status)).not.toContain('bob-secret')
    expect(JSON.stringify(status)).not.toContain('payload')
  })
})

describe('multi-user workspace and integration surfaces', () => {
  it('requires the linked Git common storage to belong to the same owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-user-'))
    const previous = process.env.SUBPOLAR_PROJECTS_ROOT
    process.env.SUBPOLAR_PROJECTS_ROOT = root
    try {
      await mkdir(join(root, 'bob', '.git', 'worktrees', 'linked'), { recursive: true })
      await mkdir(join(root, 'linked'))
      await writeFile(join(root, 'linked', '.git'), `gitdir: ${join(root, 'bob', '.git', 'worktrees', 'linked')}\n`)
      const db = unfiltered({ projects: [project('bob', 'bob', join(root, 'bob'))] })
      const repo = new ProjectSessionRepository(db.client)
      await expect(repo.assertProjectPathAvailable('alice', join(root, 'linked'))).rejects.toThrow()
      await expect(repo.assertProjectPathAvailable('bob', join(root, 'linked'))).resolves.toBeUndefined()
      await mkdir(join(root, 'alice', '.git'), { recursive: true })
      db.rows.projects!.push(project('alice', 'alice', join(root, 'alice')))
      await writeFile(join(root, 'bob', '.git', 'worktrees', 'linked', 'commondir'), join(root, 'alice', '.git'))
      await expect(repo.assertProjectPathAvailable('bob', join(root, 'linked'))).rejects.toThrow()
      await symlink(join(root, 'bob'), join(root, 'alias'))
      await expect(repo.assertProjectPathAvailable('alice', join(root, 'alias'))).rejects.toThrow()
    } finally { if (previous === undefined) delete process.env.SUBPOLAR_PROJECTS_ROOT; else process.env.SUBPOLAR_PROJECTS_ROOT = previous; await rm(root, { recursive: true, force: true }) }
  })

  it('does not enumerate the shared parent, and dispatches literal directory routes before numeric ids', async () => {
    const root = configuredWorkspaceRoot()
    const db = unfiltered({ projects: [project('bob-private', 'bob', join(root, 'bob-private')), project('own', 'alice', join(root, 'alice'))] })
    let reads = 0
    const deps = { applicationDatabase: async () => db.client, createProjectSessionRepository: (client: any) => new ProjectSessionRepository(client), projectsRoot: root, canonicalProjectPath, isPathWithin, safeProjectPath: assertPathWithinWorkspace, readdirSync: () => { reads++; throw new Error('must not enumerate parent') } }
    const response = await handleProjectsRoute(routeContext('/api/projects/directories', deps))
    expect(response?.status).toBe(200)
    expect(await response!.json()).toEqual({ currentPath: '', directories: [{ name: 'own', path: join(root, 'alice') }] })
    expect(reads).toBe(0)
    expect((await handleProjectsRoute(routeContext(`/api/projects/directories?path=${encodeURIComponent(join(root, 'bob-private'))}`, deps)))?.status).toBe(403)
    const defaultPath = await handleProjectsRoute(routeContext('/api/projects/default-directory?projectName=Demo', deps))
    expect(await defaultPath!.json()).toEqual({ directory: ownerProjectDirectory('alice', 'Demo') })
  })

  it('uses collision-free owner/session snapshot keys and denies storage roots even through aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-user-review-'))
    try {
      const workspace = join(root, 'work'); const storage = join(root, 'storage')
      await mkdir(workspace); await mkdir(storage); await writeFile(join(workspace, 'file.txt'), 'safe')
      const service = new SessionWorkspaceService(storage)
      await service.request('a:b', 'c', workspace, 'GET', [], null)
      await writeFile(join(workspace, 'file.txt'), 'changed')
      const other = await service.request('a', 'b:c', workspace, 'GET', [], null)
      expect((other as any).files).toEqual([])
      expect((await service.request('a:b', 'c', workspace, 'GET', [], null) as any).files).toHaveLength(1)
      await expect(service.request('alice', 'same', storage, 'GET', ['search'], null, { query: '' })).rejects.toMatchObject({ code: 'PATH_DENIED' })
      await symlink(storage, join(root, 'alias'))
      await expect(service.request('bob', 'same', join(root, 'alias'), 'GET', ['search'], null, { query: '' })).rejects.toMatchObject({ code: 'PATH_DENIED' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('isolates browser page leases across owner changes, fences list/scope queries, and clears closed fake contexts', async () => {
    const db = unfiltered()
    const port = new FakeBrowserPort(async () => new Response('<p>alice-private-page</p>'), async () => ['93.184.216.34'])
    const browser = new BrowserSessionService(db.client, { port })
    const alice = await browser.create({ ownerId: 'alice' })
    await browser.execute({ ownerId: 'alice' }, 'open', { browserSessionId: alice.id, url: 'https://example.com' })
    expect(await browser.list({ ownerId: 'bob' })).toEqual([])
    await expect(browser.get({ ownerId: 'bob' }, alice.id)).rejects.toThrow()
    // Even durable id reuse cannot attach a new owner to the old engine context.
    db.rows.browser_sessions![0]!.owner_id = 'bob'
    expect(await browser.execute({ ownerId: 'bob' }, 'tabs', { browserSessionId: alice.id })).toEqual([])
    db.rows.browser_sessions![0]!.owner_id = 'alice'
    await browser.close({ ownerId: 'alice' }, alice.id)
    expect(await port.tabs(JSON.stringify(['alice', null, null, null, alice.id]))).toEqual([])
    db.rows.sessions = [{ id: 'foreign', user_id: 'bob', session_id: 'same' }]
    await expect(browser.create({ ownerId: 'alice', sessionId: 'same' })).rejects.toThrow()
  })

  it('fences route-level task worktree, browser audit, agent and tool projections', async () => {
    const db = unfiltered({
      task_worktrees: [{ id: 'foreign', owner_id: 'bob', task_id: 'mine', path: '/bob-private' }],
      browser_audit: [{ id: 'foreign', owner_id: 'bob', browser_session_id: 'mine', details: 'bob-private' }],
      tool_registry: [{ id: 'foreign', owner_id: 'bob', enabled: true, tool_id: 'builtin/foreign', namespace: 'builtin', metadata: { token: 'bob-private' } }],
      agent_tool_policies: [],
    })
    const base = { applicationDatabase: async () => db.client, escapeFilter: (value: string) => value }
    class Tasks { async getOwned() { return { id: 'mine', owner_id: 'alice' } } }
    const worktree = await handleTasksRoute(routeContext('/api/tasks/mine/worktree', { ...base, TaskRepository: Tasks }))
    expect(worktree?.status).toBe(404)
    class Browser { async get() { return { id: 'mine' } } }
    const audit = await handleBrowserRoute(routeContext('/api/browser/sessions/mine/audit', { ...base, BrowserSessionService: Browser }))
    expect(await audit!.json()).toEqual({ audit: [] })
    const agents = await handleAgentsRoute(routeContext('/api/agents', { ...base, ensureUserDefaults: async () => {}, listAgents: async () => [{ id: 'foreign', user_id: 'bob', system_prompt: 'bob-private' }], createProjectSessionRepository: () => ({}) }))
    expect(await agents!.json()).toEqual([])
    const tools = await handleSettingsRoute(routeContext('/api/settings/subpolar-tools', { ...base, redactSensitive: (value: unknown) => value }))
    expect(await tools!.json()).toEqual({ tools: [] })
    db.rows.tool_registry!.push({ id: 'own', owner_id: 'alice', enabled: true, tool_id: 'builtin/own', namespace: 'builtin', metadata: { contextMode: 'always', env: { CUSTOM: 'alice-secret' }, headers: { CUSTOM: 'alice-secret' }, mcp: { args: ['alice-secret'] } } })
    const safeTools = await handleSettingsRoute(routeContext('/api/settings/subpolar-tools', { ...base }))
    const projection = await safeTools!.json() as any
    expect(projection.tools).toHaveLength(1)
    expect(projection.tools[0].metadata).toEqual({ contextMode: 'always' })
    expect(JSON.stringify(projection)).not.toContain('alice-secret')
  })
})
