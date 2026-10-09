import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { History, Search } from 'lucide-react'

import { getProject, hasProjectId, listProjects } from '@/api/projects'
import { listStoredSessionsPage } from '@/api/sessions'
import { CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'

export const OPEN_SESSION_SEARCH_EVENT = 'subpolar:open-session-search'

export function openSessionSearch() {
  window.dispatchEvent(new Event(OPEN_SESSION_SEARCH_EVENT))
}

export function SessionSearchCommand({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    enabled: open,
  })
  const generalChatQuery = useQuery({
    queryKey: ['project', GENERAL_CHAT_PROJECT_ID],
    queryFn: () => getProject(GENERAL_CHAT_PROJECT_ID),
    enabled: open,
  })
  const projects = projectsQuery.data ?? []
  const projectIdsByDirectory = useMemo(() => {
    const byDirectory = new Map<string, number>()
    if (generalChatQuery.data?.fullPath) byDirectory.set(generalChatQuery.data.fullPath, GENERAL_CHAT_PROJECT_ID)
    for (const project of projects) {
      if (hasProjectId(project)) byDirectory.set(project.fullPath, project.id)
    }
    return byDirectory
  }, [generalChatQuery.data?.fullPath, projects])
  const sessionsQuery = useQuery({
    queryKey: ['session-search', search.trim()],
    queryFn: () => listStoredSessionsPage({ limit: 50, search: search.trim() || undefined }),
    enabled: open,
  })
  const sessions = (sessionsQuery.data?.sessions ?? []).filter((session) => !session.archived)

  const selectSession = (session: (typeof sessions)[number]) => {
    const projectId = session.projectId ?? (session.directory
      ? projectIdsByDirectory.get(session.directory) ?? GENERAL_CHAT_PROJECT_ID
      : GENERAL_CHAT_PROJECT_ID)
    onOpenChange(false)
    navigate(`/projects/${projectId}/sessions/${encodeURIComponent(session.id)}`)
  }

  const loading = projectsQuery.isPending || generalChatQuery.isPending || sessionsQuery.isLoading

  return (
    <CommandDialog open={open} onOpenChange={(nextOpen) => {
      onOpenChange(nextOpen)
      if (!nextOpen) setSearch('')
    }}>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search sessions…"
        aria-label="Search sessions"
      />
      <CommandList>
        {loading && <div role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">Loading sessions…</div>}
        {!loading && sessionsQuery.isError && <div role="alert" className="px-3 py-8 text-center text-sm text-destructive">Unable to load sessions.</div>}
        {!loading && !sessionsQuery.isError && sessions.length === 0 && <CommandEmpty>No matching sessions.</CommandEmpty>}
        {!loading && !sessionsQuery.isError && sessions.length > 0 && (
          <CommandGroup heading="Sessions">
            {sessions.map((session) => {
              const projectId = session.projectId ?? (session.directory
                ? projectIdsByDirectory.get(session.directory) ?? GENERAL_CHAT_PROJECT_ID
                : GENERAL_CHAT_PROJECT_ID)
              const projectName = projectId === GENERAL_CHAT_PROJECT_ID
                ? 'General Chat'
                : projects.find((project) => project.id === projectId)?.name ?? 'Project'
              const title = session.title || 'Untitled Session'
              return (
                <CommandItem
                  key={`${session.directory ?? ''}:${session.id}`}
                  value={`${title} ${projectName}`}
                  onSelect={() => selectSession(session)}
                >
                  <History className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{projectName}</span>
                  </span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}

export function SessionSearchButton({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <button
      type="button"
      aria-label="Search sessions"
      title={collapsed ? 'Search sessions (Ctrl+K)' : undefined}
      onClick={openSessionSearch}
      className={`flex w-full items-center gap-3 rounded-md p-2.5 text-sm text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${collapsed ? 'justify-center' : ''}`}
    >
      <Search className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      {!collapsed && <><span className="flex-1 text-left">Search sessions</span><kbd className="text-[10px] text-muted-foreground">Ctrl K</kbd></>}
    </button>
  )
}
