import { GENERAL_CHAT_NAME } from './project-store.ts'

export type NewSessionProject = {
  id?: string | number
  name: string
  path: string
  /** An absent list means that the project inherits the user's agents. */
  agentNames?: readonly string[]
  hasAgentOverride?: boolean
}

export type NewSessionAgent = {
  id: string
  name: string
  enabled?: boolean
  description?: string
}

export type NewSessionRouteResolution = {
  project: NewSessionProject
  agent: NewSessionAgent
}

export type NewSessionRouteErrorCode =
  | 'NEW_SESSION_PROJECT_NOT_FOUND'
  | 'NEW_SESSION_AGENT_NOT_FOUND'
  | 'NEW_SESSION_AGENT_DISABLED'
  | 'NEW_SESSION_AGENT_NOT_AVAILABLE_FOR_PROJECT'

export class NewSessionRouteError extends Error {
  readonly name = 'NewSessionRouteError'

  constructor(readonly code: NewSessionRouteErrorCode, message: string) {
    super(message)
  }
}

export function resolveNewSessionRoute(input: {
  projectName?: string
  agentName?: string
  projects: readonly NewSessionProject[]
  agents: readonly NewSessionAgent[]
}): NewSessionRouteResolution {
  const requestedProject = input.projectName?.trim() || GENERAL_CHAT_NAME
  const project = input.projects.find((candidate) => candidate.name === requestedProject)
  if (!project) {
    throw new NewSessionRouteError('NEW_SESSION_PROJECT_NOT_FOUND', 'Project was not found')
  }

  const requestedAgent = input.agentName?.trim() || 'master'
  const agent = input.agents.find((candidate) => candidate.name === requestedAgent)
  if (!agent) {
    throw new NewSessionRouteError('NEW_SESSION_AGENT_NOT_FOUND', 'Agent was not found')
  }
  if (agent.enabled === false) {
    throw new NewSessionRouteError('NEW_SESSION_AGENT_DISABLED', 'Agent is disabled')
  }

  if (project.hasAgentOverride === true && !project.agentNames?.includes(agent.name)) {
    throw new NewSessionRouteError(
      'NEW_SESSION_AGENT_NOT_AVAILABLE_FOR_PROJECT',
      'Agent is not available for this project',
    )
  }

  return { project, agent }
}
