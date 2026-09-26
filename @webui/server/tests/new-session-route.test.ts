import { describe, expect, it } from 'vitest'
import { resolveNewSessionRoute, NewSessionRouteError } from '../application/new-session-route.ts'
import { handleProjectsRoute } from '../routes/projects.ts'
import { handleLegacyRoute } from '../routes/legacy.ts'
import { handleSettingsRoute } from '../routes/settings.ts'

const projects = [
  { id: 'general', name: 'General Chat', path: '/workspace/general-chat' },
  { id: 'one', name: 'Project One', path: '/workspace/one', hasAgentOverride: true, agentNames: ['project-agent'] },
]
const agents = [
  { id: 'master-id', name: 'master', enabled: true },
  { id: 'project-id', name: 'project-agent', enabled: true },
  { id: 'disabled-id', name: 'disabled-agent', enabled: false },
]

describe('resolveNewSessionRoute', () => {
  it('serves the frontend new-session context endpoint', async () => {
    const url = new URL('http://localhost/api/new-session/resolve')
    const response = await handleProjectsRoute({
      request: new Request(url.href),
      url,
      path: ['api', 'new-session', 'resolve'],
      correlationId: 'test-request',
      authenticatedUser: { id: 'owner-a' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        applicationDatabase: async () => ({}),
        createProjectSessionRepository: () => ({ listProjects: async () => [] }),
        generalChatProject: () => ({ id: 0, name: 'General Chat', path: '/workspace/general-chat' }),
        listAgents: async () => [{ id: 'master-id', name: 'master', description: '', enabled: true }],
        resolveNewSessionRoute,
        getUserPreferences: async () => null,
        preferenceModel: () => undefined,
        projectResponse: (project: unknown) => project,
        NewSessionRouteError,
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    } as never)

    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toMatchObject({ context: { project: { name: 'General Chat' }, agent: { name: 'master' } } })
  })
  it('opens the SSE stream using the injected active-session map', async () => {
    const url = new URL('http://localhost/api/sse/stream')
    const response = await handleLegacyRoute({
      request: new Request(url.href),
      url,
      path: ['api', 'sse', 'stream'],
      correlationId: 'test-request',
      authenticatedUser: { id: 'owner-a' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        runtimeStore: async () => ({ replayEvents: async () => ({ reset: false, events: [] }) }),
        sseClients: new Set(),
        encoder: new TextEncoder(),
        active: new Map(),
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    } as never)

    expect(response?.status).toBe(200)
    const reader = response!.body!.getReader()
    const chunk = await reader.read()
    expect(new TextDecoder().decode(chunk.value)).toContain('event: connected')
    await reader.cancel()
  })

  it('does not handle removed non-SSE legacy endpoints', async () => {
    for (const pathname of ['/api/agent', '/api/provider', '/api/config', '/api/command', '/api/sessions/status']) {
      const url = new URL(`http://localhost${pathname}`)
      await expect(handleLegacyRoute({
        request: new Request(url.href),
        url,
        path: url.pathname.split('/').filter(Boolean),
        correlationId: 'test-request',
        authenticatedUser: { id: 'owner-a' },
        gatewayCredential: null,
        internalRequest: false,
        deps: {},
      } as never)).resolves.toBeUndefined()
    }
  })

  it('reads settings from the injected defaults', async () => {
    const url = new URL('http://localhost/api/settings')
    const response = await handleSettingsRoute({
      request: new Request(url.href),
      url,
      path: ['api', 'settings'],
      correlationId: 'test-request',
      authenticatedUser: { id: 'owner-a' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        DEFAULT_SETTINGS: { theme: 'dark', tts: null, stt: null },
        applicationDatabase: async () => ({}),
        getUserPreferences: async () => null,
        redactVoiceSettings: (value: unknown) => value,
        redactedDiagnostic: () => 'error',
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    } as never)

    await expect(response?.json()).resolves.toMatchObject({ preferences: { theme: 'dark' } })
  })

  it('resolves General Chat to the default agent', () => {
    expect(resolveNewSessionRoute({ projects, agents })).toMatchObject({
      project: { name: 'General Chat' },
      agent: { name: 'master' },
    })
  })

  it('rejects unknown resources with stable codes', () => {
    expect(() => resolveNewSessionRoute({ projects, agents, projectName: 'missing' })).toThrowError(NewSessionRouteError)
    try {
      resolveNewSessionRoute({ projects, agents, agentName: 'missing' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'NEW_SESSION_AGENT_NOT_FOUND' })
    }
  })

  it('does not resolve an agent omitted from the authenticated candidates', () => {
    expect(() => resolveNewSessionRoute({
      projects,
      agents: agents.filter((agent) => agent.name !== 'master'),
      agentName: 'master',
    })).toThrowError(expect.objectContaining({ code: 'NEW_SESSION_AGENT_NOT_FOUND' }))
  })

  it('rejects disabled agents', () => {
    expect(() => resolveNewSessionRoute({ projects, agents, agentName: 'disabled-agent' })).toThrowError(
      expect.objectContaining({ code: 'NEW_SESSION_AGENT_DISABLED' }),
    )
  })

  it('enforces a project agent override', () => {
    expect(() => resolveNewSessionRoute({ projects, agents, projectName: 'Project One', agentName: 'master' })).toThrowError(
      expect.objectContaining({ code: 'NEW_SESSION_AGENT_NOT_AVAILABLE_FOR_PROJECT' }),
    )
    expect(resolveNewSessionRoute({ projects, agents, projectName: 'Project One', agentName: 'project-agent' }).agent.name).toBe('project-agent')
  })
})
