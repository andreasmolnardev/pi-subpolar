import { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { sessionWorkspaceApi as api } from '@/api/session-workspace'
import { useSessionStatusForSession } from '@/stores/sessionStatusStore'
import { WorkspaceReview } from './WorkspaceReview'
import { WorkspaceFiles } from './WorkspaceFiles'
import { ProviderBrowserPanel, RepositoryContext } from './RepositoryContext'
import { WORKSPACE_OPEN_FILE, isWorkspaceOpenFileDetail, requestQuickOpen, type FileOpenRequest } from './quickOpen'
import { control, WorkspaceError } from './shared'
import { useAuthGeneration, useAuthOwner } from '@/stores/authIdentityStore'

export interface SessionWorkspaceChangesProps { sessionId: string; projectRouteId?: string }

/** Standalone launcher intended above ChatInputBar. Requires the app QueryClientProvider. */
export function SessionWorkspaceChanges({ sessionId, projectRouteId }: SessionWorkspaceChangesProps) {
  const owner = useAuthOwner()
  const generation = useAuthGeneration()
  return <WorkspaceChanges key={JSON.stringify([owner, generation, sessionId, projectRouteId])} sessionId={sessionId} projectRouteId={projectRouteId} />
}
function WorkspaceChanges({ sessionId, projectRouteId }: SessionWorkspaceChangesProps) {
  const owner = useAuthOwner()
  const generation = useAuthGeneration()
  const client = useQueryClient()
  const status = useSessionStatusForSession(sessionId)
  useEffect(() => {
    client.removeQueries({
      queryKey: ['session-repository-context'],
      predicate: query => query.queryKey[1] !== owner || query.queryKey[2] !== generation,
    })
  }, [client, owner, generation])
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'Review' | 'Files' | 'Browser' | 'Repository'>('Review')
  const [filesVisited, setFilesVisited] = useState(false)
  const [openRequest, setOpenRequest] = useState<FileOpenRequest>()
  useEffect(() => {
    const receive = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail
      if (!isWorkspaceOpenFileDetail(detail) || detail.sessionId !== sessionId) return
      setOpenRequest({ path: detail.path, requestId: detail.requestId })
      setTab('Files'); setFilesVisited(true); setOpen(true)
    }
    window.addEventListener(WORKSPACE_OPEN_FILE, receive)
    return () => window.removeEventListener(WORKSPACE_OPEN_FILE, receive)
  }, [sessionId])
  const [commitFocus, setCommitFocus] = useState(false)
  const panelId = useId()
  const panel = useRef<HTMLElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const query = useQuery({
    queryKey: ['session-workspace', sessionId, owner, generation], queryFn: () => api.get(sessionId), retry: false,
    refetchInterval: status.type !== 'idle' ? 4000 : open ? 10000 : false,
  })
  const previousStatus = useRef(status.type)
  const refetch = query.refetch
  useEffect(() => {
    if (previousStatus.current !== status.type) {
      previousStatus.current = status.type
      void refetch()
    }
  }, [status.type, refetch])
  useEffect(() => { if (open) panel.current?.focus() }, [open])
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['session-workspace', sessionId] }),
      client.invalidateQueries({ queryKey: ['session-workspace-diff', sessionId] }),
      client.invalidateQueries({ queryKey: ['session-workspace-files', sessionId] }),
      client.invalidateQueries({ queryKey: ['session-repository-context', owner, generation, sessionId, projectRouteId] }),
    ])
  }
  // Polling must also invalidate the selected diff, without touching editor drafts.
  useEffect(() => { void client.invalidateQueries({ queryKey: ['session-workspace-diff', sessionId] }) }, [client, sessionId, query.dataUpdatedAt])
  function launch(commit = false) { setTab('Review'); setCommitFocus(commit); setOpen(true) }
  function close() { setOpen(false); launcher.current?.focus() }
  const data = query.data
  return <>
    <div className="flex flex-wrap items-center gap-2 py-2 text-xs" aria-label="Session workspace">
      <button ref={launcher} className={`${control} rounded-full text-xs`} aria-expanded={open} aria-controls={panelId} onClick={() => launch()}>
        {data?.files.length ? <><span>{data.files.length} {data.files.length === 1 ? 'file' : 'files'} changed</span> <span className="text-green-600 dark:text-green-400">+{data.additions}</span> <span className="text-red-600 dark:text-red-400">−{data.deletions}</span></> : 'Workspace'}
      </button>
      <button className={control} onClick={() => launch()} aria-controls={panelId}>Review</button>
      <button className={control} onClick={() => requestQuickOpen(sessionId)} title="Search workspace files (Ctrl+K / Cmd+K)">Quick open</button>
      {!data?.files.length && <button className={control} onClick={() => { setTab('Files'); setFilesVisited(true); setOpen(true) }}>Files</button>}
      {data?.isGit && <button className={control} onClick={() => launch(true)}>Commit</button>}
      {query.isPending && <span role="status" className="text-muted-foreground">Loading workspace…</span>}
      {!open && <WorkspaceError error={query.error} retry={() => void query.refetch()} />}
    </div>
    {createPortal(<aside ref={panel} id={panelId} role="region" aria-label="Session workspace panel" tabIndex={-1} hidden={!open}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background text-foreground shadow-xl sm:w-[min(44rem,80vw)]"
      style={!open ? { display: 'none' } : undefined}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
      <header className="flex items-center justify-between border-b border-border p-4"><h2 className="font-semibold">Workspace</h2><button className={control} aria-label="Close workspace panel" onClick={close}>×</button></header>
      <div role="tablist" aria-label="Workspace views" className="flex gap-2 border-b border-border p-3">
        {(['Review', 'Files', 'Browser', 'Repository'] as const).map((name, i, all) => <button key={name} id={`${panelId}-${name}`} role="tab" aria-selected={tab === name} aria-controls={`${panelId}-${name}-content`} tabIndex={tab === name ? 0 : -1} className={`${control} ${tab === name ? 'bg-muted' : ''}`} onClick={() => { setTab(name); if (name === 'Files') setFilesVisited(true) }} onKeyDown={e => {
          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
          e.preventDefault()
          const next = all[e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]
          setTab(next); if (next === 'Files') setFilesVisited(true)
          document.getElementById(`${panelId}-${next}`)?.focus()
        }}>{name}</button>)}
      </div>
      <div className="px-4"><WorkspaceError error={query.error} retry={() => void query.refetch()} /></div>
      <div id={`${panelId}-Review-content`} role="tabpanel" aria-labelledby={`${panelId}-Review`} hidden={tab !== 'Review'} className="min-h-0 flex-1 overflow-auto">
        {data ? <WorkspaceReview sessionId={sessionId} workspace={data} refresh={refresh} commitFocus={commitFocus} /> : <p className="p-4 text-sm">{query.isPending ? 'Loading workspace…' : 'Workspace unavailable.'}</p>}
      </div>
      <div id={`${panelId}-Files-content`} role="tabpanel" aria-labelledby={`${panelId}-Files`} hidden={tab !== 'Files'} className="min-h-0 flex-1 overflow-auto" style={tab === 'Files' ? { display: 'flex', flexDirection: 'column' } : undefined}>
        {filesVisited && <WorkspaceFiles sessionId={sessionId} refresh={refresh} openRequest={openRequest} />}
      </div>
      <div id={`${panelId}-Browser-content`} role="tabpanel" aria-labelledby={`${panelId}-Browser`} hidden={tab !== 'Browser'} className="min-h-0 flex-1 overflow-auto">
        <ProviderBrowserPanel sessionId={sessionId} projectRouteId={projectRouteId} enabled={open && tab === 'Browser'} />
      </div>
      <div id={`${panelId}-Repository-content`} role="tabpanel" aria-labelledby={`${panelId}-Repository`} hidden={tab !== 'Repository'} className="min-h-0 flex-1 overflow-auto">
        <RepositoryContext sessionId={sessionId} projectRouteId={projectRouteId} enabled={open && tab === 'Repository'} />
      </div>
    </aside>, document.body)}
  </>
}
