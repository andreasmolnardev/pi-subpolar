import { useEffect, useId, useRef, useState } from 'react'
import type { FileOpenRequest } from './quickOpen'
import { useQuery } from '@tanstack/react-query'
import { sessionWorkspaceApi as api, type WorkspaceEntry } from '@/api/session-workspace'
import { control, WorkspaceError } from './shared'

import { getAuthGeneration, useAuthGeneration, useAuthOwner } from '@/stores/authIdentityStore'
import { workspaceDrafts as drafts, workspaceDraftKey, warnBeforeUnload, type OpenFile } from './cache'

function Directory({ sessionId, path, openFile }: { sessionId: string; path: string; openFile: (path: string) => void }) {
  const owner = useAuthOwner()
  const generation = useAuthGeneration()
  const query = useQuery({ queryKey: ['session-workspace-files', sessionId, owner, generation, path], queryFn: () => api.files(sessionId, path), retry: false })
  return <ul className="space-y-1 pl-3">
    {query.isPending && <li role="status" className="text-xs text-muted-foreground">Loading…</li>}
    <li><WorkspaceError error={query.error} retry={() => void query.refetch()} /></li>
    {query.data?.entries.slice().sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).map(entry => <Entry key={entry.path} entry={entry} sessionId={sessionId} openFile={openFile} />)}
    {query.data?.entries.length === 0 && <li className="text-xs text-muted-foreground">Empty directory</li>}
  </ul>
}
function Entry({ entry, sessionId, openFile }: { entry: WorkspaceEntry; sessionId: string; openFile: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  return <li>
    <button className="w-full rounded px-1 py-1 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring break-all" aria-expanded={entry.directory ? expanded : undefined} onClick={() => entry.directory ? setExpanded(!expanded) : openFile(entry.path)}>
      <span aria-hidden="true">{entry.directory ? expanded ? '▾ 📁 ' : '▸ 📁 ' : '   ▤ '}</span>{entry.name}
    </button>
    {entry.directory && expanded && <Directory sessionId={sessionId} path={entry.path} openFile={openFile} />}
  </li>
}

type WorkspaceFilesProps = { sessionId: string; refresh: () => Promise<unknown>; openRequest?: FileOpenRequest }
export function WorkspaceFiles(props: WorkspaceFilesProps) {
  const owner = useAuthOwner()
  const generation = useAuthGeneration()
  return <OwnerWorkspaceFiles key={JSON.stringify([owner, generation, props.sessionId])} {...props} />
}
function OwnerWorkspaceFiles({ sessionId, refresh, openRequest }: WorkspaceFilesProps) {
  const draftKey = workspaceDraftKey(sessionId)
  const generation = useRef(getAuthGeneration()).current
  const [files, setFiles] = useState<OpenFile[]>(() => drafts.get(draftKey) ?? [])
  const [selected, setSelected] = useState(files[0]?.path ?? '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<FileOpenRequest[]>([])
  const [focusRequest, setFocusRequest] = useState(0)
  const editor = useRef<HTMLTextAreaElement>(null)
  const file = files.find(f => f.path === selected)
  useEffect(() => {
    if (openRequest) setPending(queue => [...queue, openRequest])
  }, [openRequest])
  useEffect(() => {
    if (busy || !pending.length) return
    const request = pending[0]
    setPending(queue => queue.slice(1))
    void openFile(request.path).then(() => setFocusRequest(request.requestId))
  }, [busy, pending])
  useEffect(() => {
    if (!focusRequest || busy) return
    const frame = requestAnimationFrame(() => editor.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [focusRequest, busy, selected])
  const editorId = useId()
  function update(next: OpenFile[]) {
    if (generation !== getAuthGeneration()) return
    setFiles(next)
    const unsaved = next.filter(f => f.content !== f.expectedContent)
    if (unsaved.length) drafts.set(draftKey, unsaved)
    else drafts.delete(draftKey)
    // Keep the navigation safeguard even if this session's editor is unmounted.
    window.removeEventListener('beforeunload', warnBeforeUnload)
    if (drafts.size) window.addEventListener('beforeunload', warnBeforeUnload)
  }
  async function openFile(path: string) {
    if (busy) return
    if (files.some(f => f.path === path)) { setSelected(path); return }
    setBusy(true); setError(null)
    try {
      const result = await api.file(sessionId, path)
      update([...files, { path, content: result.content, expectedContent: result.content }]); setSelected(path)
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  function closeFile(target: OpenFile) {
    if (target.content !== target.expectedContent && !window.confirm(`Discard unsaved changes to ${target.path}?`)) return
    const next = files.filter(f => f.path !== target.path)
    update(next)
    if (selected === target.path) setSelected(next[0]?.path ?? '')
  }
  async function reload() {
    if (!file || busy) return
    if (file.content !== file.expectedContent && !window.confirm(`Discard your draft and reload ${file.path} from disk?`)) return
    setBusy(true); setError(null)
    try { const result = await api.file(sessionId, file.path); update(files.map(f => f.path === file.path ? { ...f, content: result.content, expectedContent: result.content } : f)) } catch (e) { setError(e) } finally { setBusy(false) }
  }
  async function save() {
    if (!file || busy) return
    setBusy(true); setError(null)
    try {
      const result = await api.save(sessionId, file.path, file.content, file.expectedContent)
      update(files.map(f => f.path === file.path ? { ...f, content: result.content, expectedContent: result.content } : f))
      await refresh()
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
    <nav aria-label="Workspace file explorer" className="max-h-56 overflow-auto border-b border-border p-2 sm:max-h-none sm:w-48 sm:shrink-0 sm:border-r sm:border-b-0">
      <h3 className="mb-2 px-2 text-xs font-medium uppercase text-muted-foreground">Explorer</h3>
      <Directory sessionId={sessionId} path="" openFile={p => void openFile(p)} />
    </nav>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
      <div role="tablist" aria-label="Open files" className="flex shrink-0 gap-1 overflow-x-auto">
        {files.map(f => <div className="flex shrink-0 items-center rounded-t border border-border" key={f.path}>
          <button role="tab" id={`${editorId}-${f.path}`} aria-controls={editorId} aria-selected={selected === f.path} tabIndex={selected === f.path ? 0 : -1} className={`${control} border-0 ${selected === f.path ? 'bg-muted' : ''}`} onClick={() => { setSelected(f.path); setError(null) }} onKeyDown={e => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                      e.preventDefault()
                      const index = files.indexOf(f)
                      const next = files[e.key === 'Home' ? 0 : e.key === 'End' ? files.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : files.length - 1)) % files.length]
                      setSelected(next.path); setError(null)
                      document.getElementById(`${editorId}-${next.path}`)?.focus()
                    }}>{f.path}{f.content !== f.expectedContent ? ' •' : ''}</button>
          <button className={control} aria-label={`Close ${f.path}`} disabled={busy} onClick={() => closeFile(f)}>×</button>
        </div>)}
      </div>
      <WorkspaceError error={error} />
      {busy && <p role="status" className="text-xs text-muted-foreground">Working…</p>}
      {file ? <div id={editorId} role="tabpanel" aria-labelledby={`${editorId}-${file.path}`} className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 py-2">
          <button className={control} disabled={busy || file.content === file.expectedContent} onClick={() => void save()}>Save file</button>
          <button className={control} disabled={busy} onClick={() => void reload()}>Reload from disk</button>
          <span role="status" className="text-xs text-muted-foreground">{file.content !== file.expectedContent ? 'Unsaved changes' : 'Saved'} · manual editor</span>
        </div>
        <textarea ref={editor} data-file-editor="true" aria-label={`Edit ${file.path}`} className="min-h-72 w-full flex-1 resize-none rounded border border-border bg-background p-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" spellCheck={false} value={file.content} disabled={busy} onChange={e => update(files.map(f => f.path === file.path ? { ...f, content: e.target.value } : f))} />
        <p className="text-xs text-muted-foreground">Save checks that the disk content has not changed. Drafts stay in memory when switching tabs, closing the panel, or revisiting this session.</p>
      </div> : <p className="p-4 text-sm text-muted-foreground">Choose a file to open the manual text editor. Binary and protected files cannot be edited.</p>}
    </div>
  </div>
}
