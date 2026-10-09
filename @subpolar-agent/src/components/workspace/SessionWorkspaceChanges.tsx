import { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { sessionWorkspaceApi as api } from '@/api/session-workspace'
import { useSessionStatusForSession } from '@/stores/sessionStatusStore'
import { WorkspaceReview } from './WorkspaceReview'
import { WorkspaceFiles } from './WorkspaceFiles'
import { ProviderBrowserPanel, RepositoryContext } from './RepositoryContext'
import { WORKSPACE_OPEN_FILE, isWorkspaceOpenFileDetail, requestQuickOpen, type FileOpenRequest } from './quickOpen'
import { control, WorkspaceError } from './shared'
import { useAuthGeneration, useAuthOwner } from '@/stores/authIdentityStore'

export interface SessionWorkspaceChangesProps { sessionId: string; projectRouteId?: string; openRequest?: number; openButtonRef?: { current: HTMLButtonElement | null } }

/** Requires the app QueryClientProvider. */
export function SessionWorkspaceChanges({ sessionId, projectRouteId, openRequest, openButtonRef }: SessionWorkspaceChangesProps) {
  const owner = useAuthOwner()
  const generation = useAuthGeneration()
  return <WorkspaceChanges key={JSON.stringify([owner, generation, sessionId, projectRouteId])} sessionId={sessionId} projectRouteId={projectRouteId} openRequest={openRequest} openButtonRef={openButtonRef} />
}
function WorkspaceChanges({ sessionId, projectRouteId, openRequest, openButtonRef }: SessionWorkspaceChangesProps) {
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
  const previousOpenRequest = useRef(0)
  const [tab, setTab] = useState<'Review' | 'Files' | 'Browser' | 'Repository'>('Review')
  const [addedViews, setAddedViews] = useState<Array<'Review' | 'Files' | 'Browser' | 'Repository'>>([])
  const [filesVisited, setFilesVisited] = useState(false)
  const [panelWidth, setPanelWidth] = useState(480)
  const resizeStart = useRef<{ x: number; width: number } | null>(null)
  const [fileOpenRequest, setFileOpenRequest] = useState<FileOpenRequest>()
  useEffect(() => {
    const receive = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail
      if (!isWorkspaceOpenFileDetail(detail) || detail.sessionId !== sessionId) return
      setFileOpenRequest({ path: detail.path, requestId: detail.requestId })
      setAddedViews(views => views.includes('Files') ? views : [...views, 'Files'])
      setTab('Files'); setFilesVisited(true); setOpen(true)
    }
    window.addEventListener(WORKSPACE_OPEN_FILE, receive)
    return () => window.removeEventListener(WORKSPACE_OPEN_FILE, receive)
  }, [sessionId])

  const panelId = useId()
  const panel = useRef<HTMLElement>(null)
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
  useEffect(() => {
    if (openRequest === undefined || openRequest === previousOpenRequest.current) return
    previousOpenRequest.current = openRequest
    setAddedViews(views => views.length === 0 ? ['Review'] : views)
    setOpen(true)
  }, [openRequest])
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
  function addView(name: 'Review' | 'Files' | 'Browser' | 'Repository') {
    setAddedViews(views => views.includes(name) ? views : [...views, name])
    setTab(name)
    if (name === 'Files') setFilesVisited(true)
    setOpen(true)
  }
  function close() { setOpen(false); openButtonRef?.current?.focus() }
  return <>
    {createPortal(<aside ref={panel} id={panelId} role="region" aria-label="Session workspace panel" tabIndex={-1} hidden={!open}
      className="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-background text-foreground shadow-xl"
      style={{ width: `min(${panelWidth}px, 90vw)`, ...(!open ? { display: 'none' } : {}) }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
      <div role="separator" aria-label="Resize workspace sidebar" aria-orientation="vertical" className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none hover:bg-primary/40" onPointerDown={e => { resizeStart.current = { x: e.clientX, width: panelWidth }; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={e => { if (!resizeStart.current) return; setPanelWidth(Math.max(300, Math.min(window.innerWidth * 0.85, resizeStart.current.width + resizeStart.current.x - e.clientX))) }} onPointerUp={() => { resizeStart.current = null }} />
      <header className="flex items-center justify-between border-b border-border p-4"><h2 className="font-semibold">Workspace</h2><button className={control} aria-label="Close workspace panel" onClick={close}>×</button></header>
      <div role="tablist" aria-label="Workspace views" className="flex gap-2 border-b border-border p-3">
        {addedViews.map((name, i, all) => <button key={name} id={`${panelId}-${name}`} role="tab" aria-selected={tab === name} aria-controls={`${panelId}-${name}-content`} tabIndex={tab === name ? 0 : -1} className={`${control} ${tab === name ? 'bg-muted' : ''}`} onClick={() => { setTab(name); if (name === 'Files') setFilesVisited(true) }} onKeyDown={e => {
          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
          e.preventDefault()
          const next = all[e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]
          setTab(next); if (next === 'Files') setFilesVisited(true)
          document.getElementById(`${panelId}-${next}`)?.focus()
        }}>{name}</button>)}
        <Popover><PopoverTrigger asChild><button className={control} aria-label="Add sidebar view"><Plus className="h-4 w-4" /></button></PopoverTrigger><PopoverContent align="end" className="w-48 p-1">{(['Review', 'Files', 'Browser', 'Repository'] as const).map(name => <button key={name} type="button" className={`${control} flex h-9 w-full justify-start`} onClick={() => addView(name)}>{addedViews.includes(name) ? '✓ ' : '+ '}{name}</button>)}<button type="button" className={`${control} flex h-9 w-full justify-start`} onClick={() => requestQuickOpen(sessionId)}>Quick open</button></PopoverContent></Popover>
      </div>
      <div className="px-4"><WorkspaceError error={query.error} retry={() => void query.refetch()} /></div>
      <div id={`${panelId}-Review-content`} role="tabpanel" aria-labelledby={`${panelId}-Review`} hidden={tab !== 'Review'} className="min-h-0 flex-1 overflow-auto">
        {query.data ? <WorkspaceReview sessionId={sessionId} workspace={query.data} refresh={refresh} commitFocus={false} /> : <p className="p-4 text-sm">{query.isPending ? 'Loading workspace…' : 'Workspace unavailable.'}</p>}
      </div>
      <div id={`${panelId}-Files-content`} role="tabpanel" aria-labelledby={`${panelId}-Files`} hidden={tab !== 'Files'} className="min-h-0 flex-1 overflow-auto" style={tab === 'Files' ? { display: 'flex', flexDirection: 'column' } : undefined}>
        {filesVisited && <WorkspaceFiles sessionId={sessionId} refresh={refresh} openRequest={fileOpenRequest} />}
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
