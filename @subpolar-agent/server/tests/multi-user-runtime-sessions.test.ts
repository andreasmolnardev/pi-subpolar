import { describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ created: [] as any[], loaders: [] as any[] }))
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/stub-host-pi',
  SettingsManager: { inMemory: () => ({ isolated: true }) },
  buildContextEntries: (entries: unknown[]) => entries,
  SessionManager: { inMemory: (_cwd: string, options: { id: string }) => {
    const entries: unknown[] = []
    return { id: options.id, appendMessage: (message: unknown) => entries.push({ type: 'message', message }), getEntries: () => [...entries], getLeafId: () => null }
  } },
  DefaultResourceLoader: class {
    constructor(options: unknown) { sdk.loaders.push(options) }
    async reload() {}
  },
  createAgentSession: async (options: any) => {
    const listeners = new Set<(event: unknown) => void>()
    const session = {
      options, sessionManager: options.sessionManager, dispose: vi.fn(),
      subscribe: (listener: (event: unknown) => void) => { listeners.add(listener) },
      prompt: async (text: string) => {
        options.sessionManager.appendMessage({ role: 'user', content: text })
        for (const listener of listeners) listener({ type: 'agent_start' })
        await Promise.resolve()
        for (const listener of listeners) listener({ type: 'agent_settled' })
      },
    }
    sdk.created.push(session)
    return { session }
  },
}))
import { PiSdkSession, type PiSdkSessionHost, type SessionRecord } from '../application/runtime/pi-sdk-session.ts'

function fixture() {
  const writes: { owner: string; id: string; entries: unknown[] }[] = []
  const events: { owner: string; message: unknown }[] = []
  const host: PiSdkSessionHost = {
    getClient: async () => ({}), prepareUser: async () => {},
    resolveContext: async () => ({ agentName: 'master' }),
    loadRuntime: async () => ({ agent: { name: 'master' }, systemPrompt: 'owned prompt', pi: { allowedToolNames: ['subpolar_tool'] } }) as never,
    getProviderRuntime: async (owner) => ({ owner, getModel: () => undefined }) as never,
    createRoutingExtension: () => (() => {}) as never, createToolGateway: async () => ({}) as never,
    listTools: async () => [], searchTools: async () => [], describeTool: async () => ({}),
    onApproval: () => {}, extensionFactories: [], baseUrl: 'http://stub', internalToken: 'stub',
    parseModelSelection: () => undefined,
    loadTranscript: async (_client, owner, id) => ({ entries: [{ type: 'message', message: { role: 'user', content: `history:${owner}:${id}` } }], leafId: null }),
    saveTranscript: async (_client, owner, id, entries) => { writes.push({ owner, id, entries: structuredClone([...entries]) }) },
    acknowledgeQueueReceipt: () => undefined, saveState: async () => {}, redactEvent: (value) => value as never,
    publishStatus: () => {}, publishEvent: (record, message) => { events.push({ owner: record.userId!, message }) },
    onAgentSettled: () => {},
  }
  const record = (owner: string, id = 'same'): SessionRecord => ({ userId: owner, id, project: 'stub', title: 'stub', createdAt: 1, updatedAt: 1, tags: [] })
  const create = (value: SessionRecord) => new PiSdkSession(value, { name: 'stub', path: '/owned/stub' }, { host })
  return { host, writes, events, record, create }
}

describe('multi-user transient Pi sessions (dependency stubbed)', () => {
  it('keeps concurrent same-id owners and separate sessions isolated', async () => {
    const { create, record, writes, events } = fixture()
    const sessions = [create(record('alice')), create(record('bob')), create(record('alice', 'other'))]
    await Promise.all(sessions.map((session) => session.readyPromise))
    const seen = sessions.map(() => [] as unknown[])
    sessions.forEach((session, i) => session.onMessage((message) => seen[i].push(message)))
    await Promise.all(sessions.map((session, i) => session.send({ type: 'prompt', message: `prompt-${i}` })))
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i]!
      expect(JSON.stringify(session.entries)).toContain(`history:${session.record.userId}:${session.record.id}`)
      expect(JSON.stringify(session.entries)).toContain(`prompt-${i}`)
      for (let j = 0; j < sessions.length; j++) if (j !== i) expect(JSON.stringify(session.entries)).not.toContain(`prompt-${j}`)
      expect(seen[i]).toHaveLength(1)
      const ownedWrites = writes.filter((write) => write.owner === session.record.userId && write.id === session.record.id)
      expect(ownedWrites.length).toBeGreaterThan(0)
      expect(JSON.stringify(ownedWrites)).toContain(`prompt-${i}`)
      session.close()
    }
    expect(events.map((event) => event.owner).sort()).toEqual(['alice', 'alice', 'bob'])
    const loaders = sdk.loaders.slice(-3)
    for (const loader of loaders) {
      expect(loader).toMatchObject({ noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, settingsManager: { isolated: true } })
      expect(loader.appendSystemPromptOverride()).toEqual([])
    }
    expect(sdk.created.slice(-3).map((session) => session.options.modelRuntime.owner)).toEqual(['alice', 'bob', 'alice'])
    expect(sdk.created.at(-1).options).toMatchObject({ noTools: 'builtin', tools: ['subpolar_tool'] })
  })

  it('cannot retarget a live session through the supplied mutable record', async () => {
    const { create, record, writes } = fixture()
    const supplied = record('alice')
    const session = create(supplied)
    supplied.userId = 'bob'; supplied.id = 'foreign'
    await session.send({ type: 'prompt', message: 'owned' })
    expect(session.record.userId).toBe('alice')
    expect(session.record.id).toBe('same')
    expect(writes.every((write) => write.owner === 'alice' && write.id === 'same')).toBe(true)
    expect(() => { session.record.userId = 'bob' }).toThrow()
    session.close()
  })

  it('rejects ownerless sessions and disposes resources when closed during initialization', async () => {
    const { create, record } = fixture()
    expect(() => create(record(''))).toThrow('required')
    const session = create(record('alice'))
    session.close()
    await expect(session.readyPromise).rejects.toThrow('closed')
    expect(sdk.created.at(-1).dispose).toHaveBeenCalledOnce()
  })
})
