import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
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

  if (contextQuery.isLoading) return <div className="flex h-dvh items-center justify-center">Loading...</div>
  if (contextQuery.isError || !contextQuery.data) return <NewSessionError error={contextQuery.error} />

  const context = contextQuery.data

  return (
    <div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-gradient-to-br from-background via-background to-background">
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-12 sm:pb-16">
        <div className="flex w-full max-w-3xl flex-col items-center gap-6">
          <div className="text-center">
            <p className="text-2xl text-muted-foreground">Ready to dive in</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {context.project.name} · {context.agent.name}
            </p>
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
            hideAgentSelect={Boolean(route.agentName)}
          />
        </div>
      </div>
    </div>
  )
}
