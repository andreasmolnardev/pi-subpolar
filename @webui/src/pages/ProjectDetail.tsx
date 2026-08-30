import { useCallback, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getProject } from '@/api/projects'
import { SessionList } from '@/components/session/SessionList'
import { ChatInputBar } from '@/components/chat/ChatInputBar'
import { FileBrowserSheet } from '@/components/file-browser/FileBrowserSheet'
import { Header } from '@/components/ui/header'
import { ProjectConfigDialog } from '@/components/project/ProjectConfigDialog'
import { ProjectMcpDialog } from '@/components/project/ProjectMcpDialog'
import { ProjectSkillsDialog } from '@/components/project/ProjectSkillsDialog'
import { useCreateSession } from '@/hooks/usePiHarness'
import { useProjectActivity } from '@/hooks/useProjectActivity'
import { useSSE } from '@/hooks/useSSE'
import { useDialogParam } from '@/hooks/useDialogParam'
import { SUBPOLAR_API_BASE_URL } from '@/config'
import { Button } from '@/components/ui/button'
import { Plus, Loader2 } from 'lucide-react'
import { invalidateConfigCaches } from '@/lib/queryInvalidation'
import { useSidebarAction } from '@/hooks/useSidebarAction'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const projectId = Number(id) || 0
  const [fileBrowserOpen, setFileBrowserOpen] = useDialogParam('files')
  const [switchConfigOpen, setSwitchConfigOpen] = useState(false)
  const [mcpDialogOpen, setMcpDialogOpen] = useDialogParam('mcp')
  const [skillsDialogOpen, setSkillsDialogOpen] = useDialogParam('skills')

  const { data: project, isLoading: projectLoading } = useQuery({
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

  const createSessionMutation = useCreateSession(apiUrl, composerDirectory, (session) => {
    navigate(sessionUrl(session.id))
  })

  const handleCreateSession = async (options?: {
    agentSlug?: string
    promptSlug?: string
  }) => {
    await createSessionMutation.mutateAsync({
      agent: options?.agentSlug,
    })
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

  if (!project) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <p className="text-muted-foreground">
          Project not found
        </p>
      </div>
    )
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
            disabled={!apiUrl || createSessionMutation.isPending}
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
          />
        )}
      </div>

      <div className="px-4 pb-4 pt-2">
        <ChatInputBar defaultProjectId={projectId.toString()} sendImmediately />
      </div>

      <FileBrowserSheet
        isOpen={fileBrowserOpen}
        onClose={() => setFileBrowserOpen(false)}
        basePath={project.fullPath}
        repoName={project.name}
        repoId={projectId}
        allowNavigateAboveBase={true}
      />

      <ProjectMcpDialog
        open={mcpDialogOpen}
        onOpenChange={setMcpDialogOpen}
        directory={composerDirectory}
      />

      <ProjectSkillsDialog
        open={skillsDialogOpen}
        onOpenChange={setSkillsDialogOpen}
        projectId={projectId}
      />

      {project && (
        <ProjectConfigDialog
          open={switchConfigOpen}
          onOpenChange={setSwitchConfigOpen}
          projectId={projectId}
          currentConfigName={project.piConfigName}
          onConfigSwitched={(configName) => {
            queryClient.setQueryData(['project', projectId], {
              ...project,
              piConfigName: configName,
            })
            invalidateConfigCaches(queryClient)
          }}
        />
      )}
    </div>
  )
}
