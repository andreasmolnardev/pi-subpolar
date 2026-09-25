import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { CircleChevronDown } from 'lucide-react'

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { listProjects, type Project } from '@/api/projects'
import { getProviders } from '@/api/providers'
import { SUBPOLAR_API_BASE_URL } from '@/config'
import { useAgents } from '@/hooks/usePiHarness'
import { useSettings } from '@/hooks/useSettings'
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
  const { preferences } = useSettings()
  useSidebarAction('new-session', () => {
    navigate(newSessionPath(route))
  })

  const contextQuery = useQuery({
    queryKey: ['new-session-context', route.projectName, route.agentName],
    queryFn: () => resolveNewSessionContext(route),
  })
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const providersQuery = useQuery({ queryKey: ['subpolar', 'providers', 'new-session'], queryFn: () => getProviders(), staleTime: 30000 })
  const [projectId, setProjectId] = useState<string>()
  const [agentName, setAgentName] = useState<string>()
  const [permission, setPermission] = useState<string>()
  const [model, setModel] = useState('__auto__')
  const [customized, setCustomized] = useState(() => Boolean(route.agentName))
  const [hoveringCustomize, setHoveringCustomize] = useState(() => Boolean(route.agentName))
  const [controlsPinned, setControlsPinned] = useState(false)
  const customizationCardRef = useRef<HTMLDivElement>(null)
  const customizationHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (customizationHideTimerRef.current) clearTimeout(customizationHideTimerRef.current)
  }, [])

  useEffect(() => {
    const context = contextQuery.data
    if (!context || customized) return
    setProjectId(String(context.project.id))
    setAgentName(route.agentName ? context.agent.name : undefined)
    setPermission(context.defaults.permission)
    setModel(context.defaults.model ?? preferences?.defaultModel ?? '__auto__')
  }, [contextQuery.data, customized, preferences?.defaultModel, route.agentName])

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
  const modelOptions = useMemo(() => {
    const values = (providersQuery.data?.providers ?? [])
      .filter((provider) => provider.isConnected)
      .flatMap((provider) => Object.entries(provider.models ?? {}).map(([modelId, providerModel]) => ({
        value: `${provider.id}/${modelId}`,
        label: providerModel.name || modelId,
        provider: provider.name || provider.id,
      })))
    if (model !== '__auto__' && !values.some((option) => option.value === model)) {
      values.unshift({ value: model, label: model, provider: 'Configured' })
    }
    return values
  }, [model, providersQuery.data])

  if (contextQuery.isLoading) return <div className="flex h-dvh items-center justify-center">Loading...</div>
  if (contextQuery.isError || !contextQuery.data) return <NewSessionError error={contextQuery.error} />

  const context = contextQuery.data
  const selectedPermission = permission ?? context.defaults.permission
  const controlsVisible = customized || hoveringCustomize || controlsPinned
  const cancelCustomizationHide = () => {
    if (customizationHideTimerRef.current) {
      clearTimeout(customizationHideTimerRef.current)
      customizationHideTimerRef.current = null
    }
  }
  const scheduleCustomizationHide = () => {
    if (customized) return
    cancelCustomizationHide()
    customizationHideTimerRef.current = setTimeout(() => {
      setHoveringCustomize(false)
      customizationHideTimerRef.current = null
    }, 2000)
  }
  const handleSelectOpenChange = (open: boolean) => {
    if (open) {
      setControlsPinned(true)
      return
    }

    requestAnimationFrame(() => {
      const pointerOnRow = customizationCardRef.current?.matches(':hover') ?? false
      if (pointerOnRow) setHoveringCustomize(true)
      setControlsPinned(false)
    })
  }
  const markCustomized = () => {
    setCustomized(true)
    setHoveringCustomize(true)
  }

  return (
    <div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-gradient-to-br from-background via-background to-background">
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-12 sm:pb-16">
        <div className="flex w-full max-w-3xl flex-col items-center gap-6">
          <div
            ref={customizationCardRef}
            className="w-full text-center"
            onMouseEnter={() => { cancelCustomizationHide(); setHoveringCustomize(true) }}
            onMouseLeave={scheduleCustomizationHide}
            onFocus={() => { cancelCustomizationHide(); setHoveringCustomize(true) }}
          >
            <p className="mb-2 text-2xl text-muted-foreground">Ready to dive in</p>
            <div className="relative h-8 max-h-8 overflow-hidden">
              <div
                aria-hidden={controlsVisible}
                inert={controlsVisible}
                className={`absolute inset-0 flex h-8 max-h-8 items-center justify-center transition-transform duration-300 ease-out ${controlsVisible ? '-translate-y-full' : 'translate-y-0'}`}
              >
                <button
                  type="button"
                  tabIndex={controlsVisible ? -1 : 0}
                  className="group inline-flex h-8 max-h-8 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  onClick={() => setHoveringCustomize(true)}
                  aria-label="Customize project, agent, model, and permissions"
                >
                  <span>Your request will be routed to a matching agent.</span>
                  <span className="text-xs underline decoration-dotted underline-offset-4">Customize</span>
                </button>
              </div>
              <div
                aria-hidden={!controlsVisible}
                inert={!controlsVisible}

                className={`absolute inset-0 h-8 max-h-8 transition-transform duration-300 ease-out ${controlsVisible ? 'translate-y-0' : 'translate-y-full pointer-events-none'}`}
              >
                <div className="flex h-8 max-h-8 w-full min-w-0 flex-nowrap items-center justify-center gap-1 overflow-hidden whitespace-nowrap text-sm">
                  <Select
                    onOpenChange={handleSelectOpenChange}
                    value={resolvedProjectId}
                    onValueChange={(value) => {
                      if (value !== resolvedProjectId) markCustomized()
                      setProjectId(value)
                      setAgentName(undefined)
                    }}
                  >
                    <SelectTrigger className="h-8 w-auto gap-1 border-0 bg-transparent px-2 text-sm font-normal shadow-none hover:bg-accent focus:ring-0 [&>svg:last-child]:hidden">
                      <span>{selectedProject?.name ?? context.project.name}</span>
                      <CircleChevronDown className="h-4 w-4 text-muted-foreground" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px] overflow-y-auto">
                      {projectOptions.map((project) => <SelectItem key={project.id} value={String(project.id)}>{project.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <span aria-hidden="true" className="text-muted-foreground">•</span>
                  <Select
                    onOpenChange={handleSelectOpenChange}
                    value={agentName ?? '__default__'}
                    onValueChange={(value) => {
                      if (value !== '__default__' || agentName !== undefined) markCustomized()
                      setAgentName(value === '__default__' ? undefined : value)
                    }}
                  >
                    <SelectTrigger className="h-8 w-auto gap-1 border-0 bg-transparent px-2 text-sm font-normal shadow-none hover:bg-accent focus:ring-0 [&>svg:last-child]:hidden">
                      <SelectValue placeholder="Auto agent" />
                      <CircleChevronDown className="h-4 w-4 text-muted-foreground" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px] overflow-y-auto">
                      <SelectItem value="__default__">Auto agent</SelectItem>
                      {visibleAgents.map((agent) => <SelectItem key={agent.name} value={agent.name}>{agent.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <span aria-hidden="true" className="text-muted-foreground">•</span>
                  <Select onOpenChange={handleSelectOpenChange} value={model} onValueChange={(value) => { if (value !== model) markCustomized(); setModel(value) }}>
                    <SelectTrigger className="h-8 w-auto max-w-48 gap-1 border-0 bg-transparent px-2 text-sm font-normal shadow-none hover:bg-accent focus:ring-0 [&>svg:last-child]:hidden">
                      <SelectValue placeholder="Auto model" />
                      <CircleChevronDown className="h-4 w-4 text-muted-foreground" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px] overflow-y-auto">
                      <SelectItem value="__auto__">Auto model</SelectItem>
                      {Array.from(new Map(modelOptions.map((option) => [option.provider, option])).values()).map((option) => (
                        <SelectGroup key={option.provider}>
                          <SelectLabel>{option.provider}</SelectLabel>
                          {modelOptions.filter((item) => item.provider === option.provider).map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                  <span aria-hidden="true" className="text-muted-foreground">•</span>
                  <Select onOpenChange={handleSelectOpenChange} value={selectedPermission} onValueChange={(value) => { if (value !== selectedPermission) markCustomized(); setPermission(value) }}>
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
            </div>
          </div>

          <ChatInputBar
            defaultProjectId={String(context.project.id)}
            defaultAgent="__default__"
            defaultModel={model}
            defaultPermission={context.defaults.permission}
            projectId={resolvedProjectId}
            agent={agentName}
            permission={selectedPermission}
            model={model}
            onModelChange={(value) => { if (value !== model) markCustomized(); setModel(value) }}
            routingEnabled={!customized}
            hideModelSelect
          />
        </div>
      </div>
    </div>
  )
}
