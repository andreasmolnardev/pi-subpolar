import { describe, expect, it } from 'vitest'
import { resolveNewSessionRoute, NewSessionRouteError } from '../application/new-session-route.ts'

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
