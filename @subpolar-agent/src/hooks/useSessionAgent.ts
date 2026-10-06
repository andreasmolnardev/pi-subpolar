import { useMemo, useRef, useEffect } from 'react'
import { useMessages, useConfig, useAgents, useSession } from '@/hooks/usePiHarness'
import { useSessionAgentStore } from '@/stores/sessionAgentStore'
import type { components } from '@/api/opencode-types'

type UserMessage = components['schemas']['UserMessage']

interface AgentInfo {
  name: string
  mode?: string
  hidden?: boolean
}

const getPrimaryAgents = (agents: AgentInfo[] | undefined): AgentInfo[] => {
  return agents?.filter(
    (agent) => (agent.mode === 'primary' || agent.mode === 'all') && !agent.hidden
  ) ?? []
}

const resolveAvailableAgentName = (
  agentName: string | undefined,
  agents: AgentInfo[] | undefined,
  agentsLoaded: boolean
): string | undefined => {
  if (!agentName) return undefined
  if (!agentsLoaded) return agentName

  const normalizedAgentName = agentName.toLowerCase()
  return getPrimaryAgents(agents).find(
    (agent) => agent.name.toLowerCase() === normalizedAgentName
  )?.name
}

export function resolveDefaultSessionAgent(
  configDefaultAgent: string | undefined,
  agents: AgentInfo[] | undefined,
  agentsLoaded: boolean
): string {
  const primaryAgents = getPrimaryAgents(agents)

  const resolvedConfigAgent = resolveAvailableAgentName(configDefaultAgent, agents, agentsLoaded)
  if (resolvedConfigAgent) {
    return resolvedConfigAgent
  }

  if (agentsLoaded && primaryAgents.length > 0) {
    return primaryAgents[0].name
  }

  return 'build'
}

interface SessionAgentResult {
  agent: string
  model: { providerID: string; modelID: string } | undefined
  permission: string | undefined
  variant: string | undefined
  fromMessage: boolean
  fromSession: boolean
}

function sessionModel(value: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined
  const [providerID, ...modelParts] = value.split('/')
  const modelID = modelParts.join('/')
  return providerID && modelID ? { providerID, modelID } : undefined
}

export function useSessionAgent(
  apiUrl: string | null | undefined,
  sessionID: string | undefined,
  directory?: string
) {
  const { data: messages, isLoading: messagesLoading, isFetching: messagesFetching } = useMessages(apiUrl, sessionID, directory)
  const { data: session } = useSession(apiUrl, sessionID, directory)
  const { data: config } = useConfig(apiUrl, directory)
  const { data: agents, isSuccess: agentsLoaded } = useAgents(apiUrl, directory)
  const storedAgent = useSessionAgentStore((s) => s.agents[sessionID ?? ''] ?? null)
  const setAgent = useSessionAgentStore((s) => s.setAgent)
  const prevRef = useRef<SessionAgentResult>({ agent: 'build', model: undefined, permission: undefined, variant: undefined, fromMessage: false, fromSession: false })

  const defaultAgent = useMemo(
    () => resolveDefaultSessionAgent(config?.default_agent, agents, agentsLoaded),
    [config?.default_agent, agents, agentsLoaded]
  )

  const result = useMemo(() => {
    if (messagesLoading || messagesFetching) {
      return { agent: defaultAgent, model: undefined, permission: undefined, variant: undefined, fromMessage: false, fromSession: false }
    }

    const persistedAgent = resolveAvailableAgentName(session?.profile, agents, agentsLoaded)
    const storedAgentName = resolveAvailableAgentName(storedAgent ?? undefined, agents, agentsLoaded)
    const persistedModel = sessionModel(session?.model)
    const persistedPermission = session?.permissionOverride

    if (!messages || messages.length === 0) {
      const agent = persistedAgent ?? storedAgentName ?? defaultAgent
      if (persistedAgent || persistedModel || persistedPermission) {
        return { agent, model: persistedModel, permission: persistedPermission, variant: undefined, fromMessage: false, fromSession: true }
      }
      return { agent, model: undefined, permission: undefined, variant: undefined, fromMessage: false, fromSession: false }
    }

    let latestAgent: string | undefined
    let latestModel: { providerID: string; modelID: string } | undefined
    let latestPermission: string | undefined
    let latestVariant: string | undefined

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgWithParts = messages[i]
      if (msgWithParts.info.role === 'user') {
        const userInfo = msgWithParts.info as UserMessage
        const permission = 'permission' in userInfo && typeof userInfo.permission === 'string'
          ? userInfo.permission
          : undefined
        if (userInfo.agent || userInfo.model || permission || userInfo.variant) {
          latestAgent = userInfo.agent
          latestModel = userInfo.model
          latestPermission = permission
          latestVariant = userInfo.variant
          break
        }
      }
    }

    const resolvedLatestAgent = resolveAvailableAgentName(latestAgent, agents, agentsLoaded)
    if (resolvedLatestAgent || latestModel || latestPermission || latestVariant) {
      const agent = resolvedLatestAgent ?? persistedAgent ?? storedAgentName ?? defaultAgent
      const model = latestModel ?? persistedModel
      const permission = latestPermission ?? persistedPermission
      const prev = prevRef.current
      if (
        prev.agent === agent &&
        prev.variant === latestVariant &&
        prev.permission === permission &&
        prev.model?.providerID === model?.providerID &&
        prev.model?.modelID === model?.modelID
      ) {
        return { ...prev, fromMessage: true, fromSession: false }
      }

      const next: SessionAgentResult = {
        agent,
        model,
        permission,
        variant: latestVariant,
        fromMessage: true,
        fromSession: false,
      }
      prevRef.current = next
      return next
    }

    if (persistedAgent || persistedModel || persistedPermission) {
      const agent = persistedAgent ?? storedAgentName ?? defaultAgent
      const prev = prevRef.current
      if (
        prev.agent === agent &&
        prev.variant === undefined &&
        prev.permission === persistedPermission &&
        prev.model?.providerID === persistedModel?.providerID &&
        prev.model?.modelID === persistedModel?.modelID
      ) {
        return { ...prev, fromMessage: false, fromSession: true }
      }

      const next: SessionAgentResult = { agent, model: persistedModel, permission: persistedPermission, variant: undefined, fromMessage: false, fromSession: true }
      prevRef.current = next
      return next
    }

    return { agent: storedAgentName ?? defaultAgent, model: undefined, permission: undefined, variant: undefined, fromMessage: false, fromSession: false }
  }, [messages, messagesLoading, messagesFetching, storedAgent, session?.profile, session?.model, session?.permissionOverride, defaultAgent, agents, agentsLoaded])

  useEffect(() => {
    if (result.agent && sessionID && (result.fromMessage || result.fromSession)) {
      setAgent(sessionID, result.agent)
    }
  }, [result.agent, result.fromMessage, result.fromSession, sessionID, setAgent])

  return { agent: result.agent, model: result.model, permission: result.permission, variant: result.variant, fromMessage: result.fromMessage, fromSession: result.fromSession }
}

export function getSessionAgentFromMessages(
  messages: Array<{ role: string; agent?: string }> | undefined
): string | undefined {
  if (!messages || messages.length === 0) {
    return undefined
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && 'agent' in msg && msg.agent) {
      return msg.agent
    }
  }

  return undefined
}
