import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export type NewSessionContext = {
  project: {
    id: number
    name: string
    directory: string
    fullPath: string
    isGeneralChat?: boolean
    agentNames?: string[]
    hasAgentOverride?: boolean
  }
  agent: {
    id: string
    name: string
    description?: string
  }
  defaults: {
    model?: string
    permission: 'ask' | 'none' | 'allow_all'
  }
}

export async function resolveNewSessionContext(input: {
  projectName?: string
  agentName?: string
}): Promise<NewSessionContext> {
  const params: Record<string, string> = {}
  if (input.projectName) params.projectName = input.projectName
  if (input.agentName) params.agentName = input.agentName
  return fetchWrapper<{ context: NewSessionContext }>(`${API_BASE_URL}/api/new-session/resolve`, { params }).then((response) => response.context)
}
