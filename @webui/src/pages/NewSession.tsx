import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { CircleChevronDown } from 'lucide-react'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { listProjects, type Project } from '@/api/projects'
import { SUBPOLAR_API_BASE_URL } from '@/config'
import { useAgents } from '@/hooks/usePiHarness'
import { ChatInputBar } from '@/components/chat/ChatInputBar'
import { resolveNewSessionContext } from '@/api/new-session'
import { FetchError } from '@/api/fetchWrapper'
import { newSessionPath, parseNewSessionRoute } from '@/lib/new-session-route'
import { useSidebarAction } from '@/hooks/useSidebarAction'

function NewSessionError({ error }: { error: unknown }) {
  const code = error instanceof FetchError ? error.code : undefined
  const message = error instanceof Error ? error.message : 'Unable to resolve this new session'
  return (
    <div className="flex h-dvh items-center justify-center px-6 text-center">
      <div>
        <h1 className="text-lg font-semibold">Unable to start a session</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        {code && <p className="mt-1 text-xs text-muted-foreground">{code}</p>}
      </div>
    </div>
  )
}

export function NewSession() {
  const location = useLocation()
  const navigate = useNavigate()
  const route = parseNewSessionRoute(location.pathname)
  useSidebarAction('new-session', () => {
    navigate(newSessionPath(route))
  })

  const contextQuery = useQuery({
    queryKey: ['new-session-context', route.projectName, route.agentName],
    queryFn: () => resolveNewSessionContext(route),
  })
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const [projectId, setProjectId] = useState<string>()
  const [agentName, setAgentName] = useState<string>()
  const [permission, setPermission] = useState<string>()

  useEffect(() => {
    const context = contextQuery.data
    if (!context) return
    setProjectId(String(context.project.id))
    setAgentName(context.agent.name)
    setPermission(context.defaults.permission)
  }, [contextQuery.data])

  const resolvedProjectId = projectId ?? (contextQuery.data ? String(contextQuery.data.project.id) : undefined)
  const selectedProject: Project | NonNullable<typeof contextQuery.data>['project'] | undefined =
    projectsQuery.data?.find((project) => String(project.id) === resolvedProjectId) ??
    (contextQuery.data && String(contextQuery.data.project.id) === resolvedProjectId ? contextQuery.data.project : undefined)
  const agentsQuery = useAgents(SUBPOLAR_API_BASE_URL, selectedProject?.fullPath)
  const visibleAgents = (agentsQuery.data ?? []).filter((agent) =>
    !selectedProject?.hasAgentOverride || selectedProject.agentNames?.includes(agent.name),
  )
  const projectOptions = contextQuery.data
    ? Array.from(new Map([contextQuery.data.project, ...(projectsQuery.data ?? [])].map((project) => [String(project.id), project])).values())
    : []

  if (contextQuery.isLoading) return <div className="flex h-dvh items-center justify-center">Loading...</div>
  if (contextQuery.isError || !contextQuery.data) return <NewSessionError error={contextQuery.error} />

  const context = contextQuery.data

  return (
    <div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-gradient-to-br from-background via-background to-background">
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-12 sm:pb-16">
        <div className="flex w-full max-w-3xl flex-col items-center gap-6">
          <div className="text-center">
            <p className="text-2xl text-muted-foreground">Ready to dive in</p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-1 text-sm">
              <span className="text-muted-foreground">Project</span>
              <Select
                value={resolvedProjectId}
                onValueChange={(value) => {
                  setProjectId(value)
                  setAgentName('__default__')
                }}
              >
                <SelectTrigger className="h-8 w-auto gap-1 border-0 bg-transparent px-2 text-sm font-normal shadow-none hover:bg-accent focus:ring-0 [&>svg:last-child]:hidden">
                  <span>{selectedProject?.name ?? context.project.name}</span>
                  <CircleChevronDown className="h-4 w-4 text-muted-foreground" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px] overflow-y-auto">
                  {projectOptions.map((project) => (
                    <SelectItem key={project.id} value={String(project.id)}>{project.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground">· Agent</span>
              <Select value={agentName ?? context.agent.name} onValueChange={setAgentName}>
                <SelectTrigger className="h-8 w-auto gap-1 border-0 bg-transparent px-2 text-sm font-normal shadow-none hover:bg-accent focus:ring-0 [&>svg:last-child]:hidden">
                  <SelectValue placeholder="Default profile" />
                  <CircleChevronDown className="h-4 w-4 text-muted-foreground" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px] overflow-y-auto">
                  <SelectItem value="__default__">Default profile</SelectItem>
                  {visibleAgents.map((agent) => <SelectItem key={agent.name} value={agent.name}>{agent.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground">· Permission level</span>
              <Select value={permission ?? context.defaults.permission} onValueChange={setPermission}>
                <SelectTrigger className="h-8 w-auto gap-1 border-0 bg-transparent px-2 text-sm font-normal shadow-none hover:bg-accent focus:ring-0 [&>svg:last-child]:hidden">
                  <SelectValue />
                  <CircleChevronDown className="h-4 w-4 text-muted-foreground" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default Permissions</SelectItem>
                  <SelectItem value="ask">Ask for Permissions</SelectItem>
                  <SelectItem value="none">No Permissions</SelectItem>
                  <SelectItem value="allow_all">Dangerously Allow All</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/*
            First-send creation/navigation belongs in the next composer phase.
            This page owns only authenticated route resolution and initial context.
          */}
          <ChatInputBar
            defaultProjectId={String(context.project.id)}
            defaultAgent={context.agent.name}
            defaultModel={context.defaults.model}
            defaultPermission={context.defaults.permission}
            projectId={resolvedProjectId}
            agent={agentName ?? context.agent.name}
            permission={permission ?? context.defaults.permission}
          />
        </div>
      </div>
    </div>
  )
}
