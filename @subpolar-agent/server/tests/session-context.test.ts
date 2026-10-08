import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createSessionContextResolver,
  createSqliteSessionContextStore,
  SessionContextError,
  type AgentRecord,
  type ProjectRecord,
  type SessionContextDependencies,
  type SessionRecord,
} from '../application/session-context.ts'

const project: ProjectRecord = { name: 'subpolar', path: '/work/subpolar' }
const master: AgentRecord = { id: 'agent_master', user_id: 'user_1', name: 'master', enabled: true }
const build: AgentRecord = { id: 'agent_build', user_id: 'user_1', name: 'build', enabled: true }

function resolver(overrides: Partial<SessionContextDependencies> = {}) {
  const sessions: SessionRecord[] = []
  const agents = new Map([['master', master], ['build', build], [master.id, master], [build.id, build]])
  return createSessionContextResolver({
    sessions: {
      getSession: (id) => sessions.find((session) => session.id === id),
      getProject: (name) => name === project.name ? project : undefined,
    },
    agents: {
      getAgent: (userId, selector) => {
        const agent = agents.get(selector)
        return agent?.user_id === userId ? agent : undefined
      },
    },
    ...overrides,
  })
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session_1',
    project: project.name,
    title: 'A session',
    createdAt: 1,
    updatedAt: 2,
    userId: 'user_1',
    directory: project.path,
    ...overrides,
  }
}

describe('SessionContextResolver', () => {
  it.each(['ask', 'none', 'allow_all'] as const)('accepts %s as a validated request permission', async (permission) => {
    const context = await resolver().resolve({ identity: 'user_1', project: 'subpolar', permission })

    expect(context.permission).toEqual({ override: permission, requestedOverride: permission, source: 'request' })
    expect(context.permissionOverride).toBe(permission)
  })

  it('carries an explicitly requested permission into the next durable resolution', async () => {
    const stored = session()
    const contextResolver = resolver({
      sessions: {
        getSession: (id) => id === stored.id ? stored : undefined,
        getProject: (name) => name === project.name ? project : undefined,
      },
    })

    const first = await contextResolver.resolve({ identity: 'user_1', sessionId: stored.id, permission: 'none' })
    expect(first.permission.source).toBe('request')
    stored.permissionOverride = first.permissionOverride

    const next = await contextResolver.resolve({ identity: 'user_1', sessionId: stored.id })
    expect(next.permission).toEqual({ override: 'none', sessionOverride: 'none', source: 'session' })
  })

  it('rejects every permission change once a session policy is persisted', async () => {
    const permissions = ['ask', 'none', 'allow_all'] as const
    for (const storedPermission of permissions) {
      const stored = session({ permissionOverride: storedPermission })
      const contextResolver = resolver({
        sessions: {
          getSession: (id) => id === stored.id ? stored : undefined,
          getProject: (name) => name === project.name ? project : undefined,
        },
      })

      for (const requestedPermission of permissions) {
        if (requestedPermission === storedPermission) continue
        await expect(contextResolver.resolve({ identity: 'user_1', sessionId: stored.id, permission: requestedPermission }))
          .rejects.toMatchObject({ code: 'PERMISSION_MISMATCH' })
      }
    }
  })

  it('derives the canonical context for a new session from trusted identity and project', async () => {
    const context = await resolver().resolve({
      identity: { id: 'user_1' },
      project: 'subpolar',
      cwd: '/work/subpolar/packages/api',
      agentName: 'build',
      permissionOverride: 'none',
    })

    expect(context.identity).toEqual({ userId: 'user_1' })
    expect(context.session).toBeNull()
    expect(context.sessionId).toBeUndefined()
    expect(context.projectDirectory).toBe('/work/subpolar')
    expect(context.cwd).toBe('/work/subpolar/packages/api')
    expect(context.agent).toBe(build)
    expect(context.agentId).toBe('agent_build')
    expect(context.agentName).toBe('build')
    expect(context.permission).toEqual({ override: 'none', requestedOverride: 'none', source: 'request' })
  })

  it('derives session cwd and permission from storage and rejects spoofed hints', async () => {
    const stored = session({ permissionOverride: 'ask', profile: 'build', directory: '/work/subpolar/packages/api' })
    const contextResolver = resolver({
      sessions: {
        getSession: (id) => id === stored.id ? stored : undefined,
        getProject: (name) => name === project.name ? project : undefined,
      },
    })

    const context = await contextResolver.resolve({ identity: 'user_1', sessionId: stored.id, agent: 'agent_build' })
    expect(context.cwd).toBe('/work/subpolar/packages/api')
    expect(context.agentName).toBe('build')
    expect(context.permissionOverride).toBe('ask')
    expect(context.permission.source).toBe('session')

    await expect(contextResolver.resolve({ identity: 'user_1', sessionId: stored.id, cwd: project.path }))
      .rejects.toMatchObject({ code: 'SESSION_CWD_MISMATCH' })
    await expect(contextResolver.resolve({ identity: 'user_1', sessionId: stored.id, agent: 'master' }))
      .rejects.toMatchObject({ code: 'SESSION_AGENT_MISMATCH' })
    await expect(contextResolver.resolve({ identity: 'user_1', sessionId: stored.id, permission: 'allow_all' }))
      .rejects.toMatchObject({ code: 'PERMISSION_MISMATCH' })
  })

  it('does not allow a user hint or another user to select a session', async () => {
    const stored = session()
    const contextResolver = resolver({
      sessions: {
        getSession: (id) => id === stored.id ? stored : undefined,
        getProject: (name) => name === project.name ? project : undefined,
      },
    })

    await expect(contextResolver.resolve({ identity: 'user_1', userId: 'user_2', sessionId: stored.id }))
      .rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
    await expect(contextResolver.resolve({ identity: 'user_2', sessionId: stored.id }))
      .rejects.toMatchObject({ code: 'SESSION_NOT_OWNED' })
    await expect(contextResolver.resolve({ identity: 'user_1', sessionId: 'missing' }))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('rejects an unowned or escaping stored session directory', async () => {
    const outside = session({ directory: '/other-project' })
    const contextResolver = resolver({
      sessions: {
        getSession: (id) => id === outside.id ? outside : undefined,
        getProject: (name) => name === project.name ? project : undefined,
      },
    })

    await expect(contextResolver.resolve({ identity: 'user_1', sessionId: outside.id }))
      .rejects.toMatchObject({ code: 'INVALID_SESSION_DIRECTORY' })
  })

  it('resolves symlinked project paths before checking session containment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subpolar-context-'))
    const outside = mkdtempSync(join(tmpdir(), 'subpolar-context-outside-'))
    mkdirSync(join(root, 'project'))
    symlinkSync(outside, join(root, 'project', 'escape'))
    const contextResolver = createSessionContextResolver({
      sessions: { getSession: () => undefined, getProject: () => ({ name: 'subpolar', path: join(root, 'project') }) },
      agents: { getAgent: () => master },
    })

    await expect(contextResolver.resolve({ identity: 'user_1', project: 'subpolar', cwd: join(root, 'project', 'escape') }))
      .rejects.toMatchObject({ code: 'INVALID_SESSION_DIRECTORY' })
  })

  it('rejects a project directory hint that is not the stored project root', async () => {
    const contextResolver = resolver()

    await expect(contextResolver.resolve({ identity: 'user_1', project: 'subpolar', projectDirectory: '/work/other' }))
      .rejects.toMatchObject({ code: 'PROJECT_DIRECTORY_MISMATCH' })
  })

  it('requires an enabled agent owned by the authenticated user', async () => {
    const disabled: AgentRecord = { id: 'agent_disabled', user_id: 'user_1', name: 'disabled', enabled: false }
    const foreign: AgentRecord = { id: 'agent_foreign', user_id: 'user_2', name: 'foreign', enabled: true }
    const contextResolver = resolver({
      agents: {
        getAgent: (_userId, selector) => selector === 'disabled' ? disabled : selector === 'foreign' ? foreign : undefined,
      },
    })

    await expect(contextResolver.resolve({ identity: 'user_1', project: 'subpolar', agent: 'unknown' }))
      .rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
    await expect(contextResolver.resolve({ identity: 'user_1', project: 'subpolar', agent: 'disabled' }))
      .rejects.toMatchObject({ code: 'AGENT_DISABLED' })
    await expect(contextResolver.resolve({ identity: 'user_1', project: 'subpolar', agent: 'foreign' }))
      .rejects.toMatchObject({ code: 'AGENT_NOT_OWNED' })
  })

  it('rejects conflicting aliases before calling storage', async () => {
    const getProject = vi.fn(() => project)
    const contextResolver = resolver({
      sessions: {
        getSession: () => undefined,
        getProject,
      },
    })

    await expect(contextResolver.resolve({ identity: 'user_1', project: 'subpolar', projectName: 'other' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(getProject).not.toHaveBeenCalled()
  })

  it('adapts the bridge SQLite sessions and projects columns', () => {
    const rows = new Map<string, unknown>([
      ['session', { id: 'session_1', project: 'subpolar', title: 'Stored', created_at: 10, updated_at: 20, archived: 1, profile: 'build', model: null, directory: '/work/subpolar', user_id: 'user_1', permission_override: 'ask' }],
      ['project', { name: 'subpolar', path: '/work/subpolar' }],
    ])
    const database = {
      query: vi.fn((sql: string) => ({
        get: vi.fn(() => sql.includes('FROM sessions') ? rows.get('session') : rows.get('project')),
      })),
    }
    const store = createSqliteSessionContextStore(database)

    expect(store.getSession('session_1')).toMatchObject({ id: 'session_1', userId: 'user_1', profile: 'build', permissionOverride: 'ask', archived: true })
    expect(store.getProject('subpolar')).toEqual(project)
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('FROM sessions WHERE id = ?'))
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('FROM projects WHERE name = ?'))
  })

  it('throws its typed error class for invalid identity', async () => {
    await expect(resolver().resolve({ identity: { id: 'user_1', userId: 'user_2' }, project: 'subpolar' }))
      .rejects.toBeInstanceOf(SessionContextError)
  })
})
