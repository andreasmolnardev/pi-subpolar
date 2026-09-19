export type ParsedNewSessionRoute = {
  projectName?: string
  agentName?: string
}

export type NewSessionRouteParseErrorCode = 'NEW_SESSION_INVALID_ROUTE'

export class NewSessionRouteParseError extends Error {
  readonly code: NewSessionRouteParseErrorCode = 'NEW_SESSION_INVALID_ROUTE'

  constructor(message = 'Invalid new-session route') {
    super(message)
    this.name = 'NewSessionRouteParseError'
  }
}

function decodeRouteSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded.trim()) throw new NewSessionRouteParseError()
    return decoded
  } catch (error) {
    if (error instanceof NewSessionRouteParseError) throw error
    throw new NewSessionRouteParseError()
  }
}

/** Parse pathname only so a direct reload never depends on location state. */
export function parseNewSessionRoute(pathname: string): ParsedNewSessionRoute {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] !== 'new' || segments.length > 3) throw new NewSessionRouteParseError()
  if (segments.length === 1) return {}
  if (segments.length === 2) return { agentName: decodeRouteSegment(segments[1]) }
  return {
    projectName: decodeRouteSegment(segments[1]),
    agentName: decodeRouteSegment(segments[2]),
  }
}

export function newSessionPath(route: ParsedNewSessionRoute): string {
  if (!route.agentName && route.projectName) throw new NewSessionRouteParseError('An agent is required with a project')
  if (!route.agentName) return '/new'
  if (!route.projectName) return `/new/${encodeURIComponent(route.agentName)}`
  return `/new/${encodeURIComponent(route.projectName)}/${encodeURIComponent(route.agentName)}`
}
