import { describe, expect, it, vi } from 'vitest'
import { handleToolsRoute } from '../routes/tools.ts'

describe('agent debug tool listing', () => {
  it('lists tools available to the session agent, including on-demand tools', async () => {
    const listToolsForAgent = vi.fn(async () => [{ id: 'web.search', description: 'Search', inputSchema: {}, requiresApproval: false, contextMode: 'on-demand' }])
    const response = await handleToolsRoute({
      request: new Request('http://localhost/api/subpolar-cli/tools/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentName: 'researcher', sessionId: 'session-1' }),
      }),
      url: new URL('http://localhost/api/subpolar-cli/tools/list'),
      path: ['api', 'subpolar-cli', 'tools', 'list'],
      correlationId: 'debug-tools-test',
      authenticatedUser: { id: 'owner-1' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        body: async (request: Request) => request.json(),
        json: (body: unknown, status = 200) => Response.json(body, { status }),
        applicationDatabase: async () => ({}),
        ensureUserMetadata: async () => {},
        createProjectSessionRepository: () => ({ getSessionById: async () => ({ id: 'session-1', userId: 'owner-1', projectId: 'project-1', profile: 'researcher' }) }),
                resolveToolSessionContext: async () => ({ sessionId: 'session-1', agentName: 'researcher', project: { id: 'project-1' }, permissionOverride: 'ask', permission: { source: 'session' } }),
        listToolsForAgent,
      },
    } as never)

    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toMatchObject({ tools: [{ id: 'web.search' }] })
    expect(listToolsForAgent).toHaveBeenCalledWith({}, 'owner-1', 'researcher', 'project-1', true, 'ask')
  })

  it('does not list tools for sessions owned by another user', async () => {
    const listToolsForAgent = vi.fn()
    const response = await handleToolsRoute({
      request: new Request('http://localhost/api/subpolar-cli/tools/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentName: 'researcher', sessionId: 'session-1' }),
      }),
      url: new URL('http://localhost/api/subpolar-cli/tools/list'),
      path: ['api', 'subpolar-cli', 'tools', 'list'],
      correlationId: 'debug-tools-test',
      authenticatedUser: { id: 'owner-1' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        body: async (request: Request) => request.json(),
        json: (body: unknown, status = 200) => Response.json(body, { status }),
        applicationDatabase: async () => ({}),
        ensureUserMetadata: async () => {},
        createProjectSessionRepository: () => ({ getSessionById: async () => ({ id: 'session-1', userId: 'owner-2', projectId: 'project-1' }) }),
        listToolsForAgent,
      },
    } as never)

    expect(response?.status).toBe(404)
    expect(listToolsForAgent).not.toHaveBeenCalled()
  })
})
