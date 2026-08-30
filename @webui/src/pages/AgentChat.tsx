import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'
import { Bot, Sparkles } from 'lucide-react'
import { getProject } from '@/api/projects'
import { settingsApi } from '@/api/settings'
import { ChatInputBar } from '@/components/chat/ChatInputBar'
import { Card, CardContent } from '@/components/ui/card'
import { useAgents } from '@/hooks/usePiHarness'
import { useSidebarAction } from '@/hooks/useSidebarAction'
import { SUBPOLAR_API_BASE_URL } from '@/config'

interface ConfigAgent {
  description?: string
  skills?: string[]
  disable?: boolean
  [key: string]: unknown
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function formatName(name: string): string {
  return name.replace(/-/g, ' ')
}

export function AgentChat() {
  const { agentName: agentNameParam } = useParams<{ agentName: string }>()
  const agentName = agentNameParam ? decodeURIComponent(agentNameParam) : ''

  useSidebarAction('new-session', () => {})

  const { data: generalChatProject } = useQuery({
    queryKey: ['project', GENERAL_CHAT_PROJECT_ID],
    queryFn: () => getProject(GENERAL_CHAT_PROJECT_ID),
  })

  const generalChatDirectory = generalChatProject?.fullPath

  const { data: runtimeAgents = [] } = useAgents(SUBPOLAR_API_BASE_URL, generalChatDirectory)

  const { data: configs } = useQuery({
    queryKey: ['subpolar-configs'],
    queryFn: () => settingsApi.getPiConfigs(),
  })

  const { data: managedSkills = [] } = useQuery({
    queryKey: ['managed-skills', generalChatDirectory],
    queryFn: () => settingsApi.listManagedSkills(undefined, generalChatDirectory),
    enabled: Boolean(generalChatDirectory),
    staleTime: 5 * 60 * 1000,
  })

  const configAgents = useMemo(() => {
    const rawContent = configs?.defaultConfig?.rawContent
    const parsedConfig = rawContent ? tryParseJson(rawContent) : null
    return parsedConfig?.agent as Record<string, ConfigAgent> | undefined
  }, [configs?.defaultConfig?.rawContent])

  const runtimeAgent = runtimeAgents.find((agent) => agent.name === agentName)
  const configAgent = configAgents?.[agentName]
  const description = runtimeAgent?.description || configAgent?.description
  const skillNames = configAgent?.skills ?? []
  const skillsByName = new Map(managedSkills.map((skill) => [skill.name, skill]))

  return (
    <div className="h-dvh max-h-dvh overflow-hidden bg-gradient-to-br from-background via-background to-background flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-4 pb-12 sm:pb-16 overflow-y-auto">
        <div className="flex flex-col items-center gap-6 max-w-3xl w-full">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                {formatName(agentName)}
              </h1>
              {description && (
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
          </div>

          <div className="w-full">
            {skillNames.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {skillNames.map((skillName) => {
                  const skill = skillsByName.get(skillName)
                  return (
                    <Card key={skillName} className="bg-card/80 backdrop-blur-sm">
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-md bg-blue-500/10 p-2 text-blue-600 dark:text-blue-400">
                            <Sparkles className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-sm text-foreground truncate">
                              {formatName(skillName)}
                            </p>
                            {skill?.description && (
                              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                                {skill.description}
                              </p>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            ) : (
              <Card className="bg-card/60 border-dashed">
                <CardContent className="p-5 text-center text-sm text-muted-foreground">
                  No skills configured for this agent.
                </CardContent>
              </Card>
            )}
          </div>

          <ChatInputBar defaultAgent={agentName} hideAgentSelect />
        </div>
      </div>
    </div>
  )
}
