import { useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getProject, listProjects } from '@/api/projects'
import { listStoredSessionsPage, type StoredSession } from '@/api/sessions'
import { Header } from '@/components/ui/header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Plus } from 'lucide-react'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'
import { formatDistanceToNow } from 'date-fns'
import { SessionTags } from '@/components/session/SessionTags'

export function mergeStoredSessionPages(pages: Array<{ sessions: StoredSession[] }>): StoredSession[] {
  const unique = new Map<string, StoredSession>()
  for (const session of pages.flatMap((page) => page.sessions)) unique.set(session.id, session)
  return Array.from(unique.values())
}

export function History() {
  const navigate = useNavigate()

  const { data: projects, isLoading: projectsLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  })

  const { data: generalChat, isLoading: generalChatLoading } = useQuery({
    queryKey: ['project', GENERAL_CHAT_PROJECT_ID],
    queryFn: () => getProject(GENERAL_CHAT_PROJECT_ID),
  })

  const sessionsQuery = useInfiniteQuery({
    queryKey: ['sessions'],
    queryFn: ({ pageParam }) => listStoredSessionsPage({ limit: 25, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
  })
  const storedSessions = useMemo(() => {
    return mergeStoredSessionPages(sessionsQuery.data?.pages ?? [])
  }, [sessionsQuery.data])
  const { isLoading: sessionsLoading, hasNextPage, fetchNextPage, isFetchingNextPage } = sessionsQuery

  const historyProjects = useMemo(() => {
    return [generalChat, ...(projects ?? [])].filter((project): project is NonNullable<typeof project> => Boolean(project?.fullPath))
  }, [generalChat, projects])

  const projectIdsByDirectory = useMemo(() => {
    return new Map([
      ...historyProjects.map(project => [project.fullPath, project.id] as const),
      ...(storedSessions ?? [])
        .filter((session): session is typeof session & { directory: string } => Boolean(session.directory))
        .map(session => [session.directory, session.projectId ?? GENERAL_CHAT_PROJECT_ID] as const),
    ])
  }, [historyProjects, storedSessions])

  const handleSelectSession = useCallback((sessionId: string, directory: string | null, storedProjectId: number | null) => {
    const projectId = storedProjectId ?? (directory ? projectIdsByDirectory.get(directory) : GENERAL_CHAT_PROJECT_ID)
    navigate(`/projects/${projectId ?? GENERAL_CHAT_PROJECT_ID}/sessions/${sessionId}`)
  }, [navigate, projectIdsByDirectory])

  if (projectsLoading || generalChatLoading || sessionsLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header>
        <Header.Title>Session History</Header.Title>
        <Header.Actions>
          <Button
            onClick={() => navigate('/new')}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white transition-all duration-200 hover:scale-105"
          >
            <Plus className="w-4 h-4 mr-2" />
            <span>New Session</span>
          </Button>
        </Header.Actions>
      </Header>
      
      <div className="flex-1 p-4">
        <div className="max-w-6xl mx-auto">
          {(storedSessions?.length ?? 0) > 0 ? (
            <div className="flex flex-col gap-3">
              {storedSessions.map((session) => (
                <Card
                  key={session.id}
                  className="p-3 cursor-pointer transition-all bg-card border-border hover:bg-accent hover:border-border"
                  onClick={() => handleSelectSession(session.id, session.directory, session.projectId)}
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <h3 className="text-sm font-semibold text-orange-600 dark:text-orange-400 truncate">
                      {session.title || session.id}
                    </h3>
                    <div className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(session.updatedAt), { addSuffix: true })}
                    </div>
                    <SessionTags session={session} />
                  </div>
                </Card>
              ))}
              {hasNextPage && (
                <div className="flex justify-center pt-2">
                  <Button variant="outline" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                    {isFetchingNextPage ? 'Loading...' : 'Load more'}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center text-muted-foreground py-8">
              No sessions yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
