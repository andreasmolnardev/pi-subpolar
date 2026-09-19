import { useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject } from '@/api/projects'
import { SessionList } from '@/components/session/SessionList'
import { ProjectNotFoundDialog } from '@/components/project/ProjectNotFoundDialog'
import { Header } from '@/components/ui/header'
import { useProjectActivity } from '@/hooks/useProjectActivity'
import { useSSE } from '@/hooks/useSSE'
import { SUBPOLAR_API_BASE_URL } from '@/config'
import { Button } from '@/components/ui/button'
import { Plus, Loader2 } from 'lucide-react'
import { useSidebarAction } from '@/hooks/useSidebarAction'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'
import { newSessionPath } from '@/lib/new-session-route'

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const projectId = Number(id) || 0

  const { data: project, isLoading: projectLoading, isError: projectError } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
  })

  useProjectActivity(projectId, Boolean(project))

  const apiUrl = SUBPOLAR_API_BASE_URL
  const composerDirectory = project?.fullPath
  const subscriptionDirectories = useMemo(() => composerDirectory ? [composerDirectory] : [], [composerDirectory])

  useSSE(apiUrl, subscriptionDirectories)

  const sessionUrl = useCallback(
    (sessionId: string) => {
      return `/projects/${projectId}/sessions/${sessionId}`
    },
    [projectId],
  )

  const newSessionRoute = newSessionPath({
    projectName: project?.name,
    agentName: project?.agentNames?.[0] ?? 'master',
  })

  const handleCreateSession = () => {
    navigate(newSessionRoute)
  }

  const handleSelectSession = (sessionId: string) => {
    navigate(sessionUrl(sessionId))
  }

  useSidebarAction('new-session', () => {
    handleCreateSession()
  })

  if (projectLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (projectId === GENERAL_CHAT_PROJECT_ID) {
    navigate('/home', { replace: true })
    return null
  }

  if (projectError || !project) {
    return <ProjectNotFoundDialog projectId={id} />
  }

  return (
    <div className="h-dvh max-h-dvh overflow-hidden bg-gradient-to-br from-background via-background to-background flex flex-col pb-[calc(env(safe-area-inset-bottom)+56px)] sm:pb-0">
      <Header>
        <Header.BackButton to="/" />
        <div className="flex items-center gap-2 min-w-0">
          <Header.Title>{project.name}</Header.Title>
        </div>
        <Header.Actions>
          <Button
            onClick={() => handleCreateSession()}
            disabled={!apiUrl || projectLoading}
            size="sm"
            className="sm:hidden h-10 w-10 p-0 bg-blue-600 hover:bg-blue-700 text-white transition-all duration-200 hover:scale-105"
          >
            <Plus className="w-5 h-5" />
          </Button>
        </Header.Actions>
      </Header>

      <div className="flex-1 flex flex-col min-h-0">
        {apiUrl && composerDirectory && (
          <SessionList
            apiUrl={apiUrl}
            directories={[composerDirectory]}
            createDirectory={composerDirectory}
            onSelectSession={handleSelectSession}
            onNewSession={handleCreateSession}
          />
        )}
      </div>

    </div>
  )
}
