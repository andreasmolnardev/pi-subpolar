import { describe, expect, it } from 'vitest'
import { newSessionPath, parseNewSessionRoute, NewSessionRouteParseError } from './new-session-route'

describe('new-session route helpers', () => {
  it('decodes encoded project and agent names', () => {
    expect(parseNewSessionRoute('/new/My%20Project/agent%2Fone')).toEqual({ projectName: 'My Project', agentName: 'agent/one' })
    expect(parseNewSessionRoute('/new/agent%20one')).toEqual({ agentName: 'agent one' })
  })

  it('builds canonical encoded routes', () => {
    expect(newSessionPath({ projectName: 'My Project', agentName: 'agent/one' })).toBe('/new/My%20Project/agent%2Fone')
  })

  it('supports direct reload paths without browser state', () => {
    expect(parseNewSessionRoute('/new/Project%20One/agent%20one')).toEqual({ projectName: 'Project One', agentName: 'agent one' })
    expect(parseNewSessionRoute('/new')).toEqual({})
  })

  it('rejects malformed route shapes and encoding', () => {
    expect(() => parseNewSessionRoute('/new/a/b/c')).toThrowError(NewSessionRouteParseError)
    expect(() => parseNewSessionRoute('/new/%E0%A4%A')).toThrowError(NewSessionRouteParseError)
  })
})
