import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight, File, Folder, History, MessageSquarePlus, Search } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { sessionWorkspaceApi } from '@/api/session-workspace'
import { requestWorkspaceFile, sessionIdFromPath } from '@/components/workspace/quickOpen'

export interface PaletteAction {
  id: string
  label: string
  description: string
  shortcut?: string
  icon: typeof Search
  run: () => void
}
interface CommandPaletteProps { open: boolean; onOpenChange: (open: boolean) => void }

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const sessionId = sessionIdFromPath(location.pathname)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [search, setSearch] = useState<{ key: string; paths: string[]; truncated: boolean; error?: string }>()
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef(true)
  const resultsId = useId()
  const fileMode = !!sessionId && !query.startsWith('>')
  const searchKey = JSON.stringify([sessionId, query])

  const actions = useMemo<PaletteAction[]>(() => {
    const focusComposer = () => document.querySelector<HTMLTextAreaElement>('textarea:not([data-file-editor])')?.focus()
    const result: PaletteAction[] = [
      { id: 'new', label: 'New chat', description: 'Start a fresh session', shortcut: 'N', icon: MessageSquarePlus, run: () => navigate('/new') },
      { id: 'sessions', label: 'Search sessions', description: 'Find a previous conversation', shortcut: 'S', icon: History, run: () => navigate('/history') },
      { id: 'projects', label: 'Switch project', description: 'Open the project list', icon: Folder, run: () => navigate('/projects') },
    ]
    if (document.querySelector('textarea')) result.push({ id: 'composer', label: 'Focus composer', description: 'Jump to the message field', shortcut: '⌘↵', icon: Search, run: focusComposer })
    return result.filter(action => action.id !== 'composer' || location.pathname.includes('/sessions/'))
  }, [location.pathname, navigate])
  const commandQuery = (query.startsWith('>') ? query.slice(1) : query).trim().toLowerCase()
  const filtered = actions.filter(action => `${action.label} ${action.description}`.toLowerCase().includes(commandQuery))
  const currentSearch = search?.key === searchKey ? search : undefined
  const paths = currentSearch?.paths ?? []
  const count = fileMode ? paths.length : filtered.length

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    restoreFocus.current = true
    setQuery(''); setSelected(0); setSearch(undefined)
    const containFocus = (event: FocusEvent) => {
      if (restoreFocus.current && event.target instanceof Node && !dialogRef.current?.contains(event.target)) inputRef.current?.focus()
    }
    document.addEventListener('focusin', containFocus)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('focusin', containFocus)
      if (restoreFocus.current && previous?.isConnected && !previous.closest('[hidden]')) previous.focus()
    }
  }, [open, location.pathname])

  useEffect(() => {
    if (!open || !fileMode || !sessionId) return
    setSearch(undefined)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void sessionWorkspaceApi.search(sessionId, query.trim(), controller.signal).then(result => {
        if (!controller.signal.aborted) setSearch({ key: searchKey, ...result })
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setSearch({ key: searchKey, paths: [], truncated: false, error: error instanceof Error ? error.message.slice(0, 400) : 'File search failed' })
      })
    }, 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [open, fileMode, sessionId, query, searchKey])
  useEffect(() => setSelected(index => Math.min(index, Math.max(count - 1, 0))), [count])
  useEffect(() => {
    dialogRef.current?.querySelector(`[data-result-index="${selected}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, count])

  if (!open) return null
  function run(index: number) {
    if (fileMode) {
      const path = paths[index]
      if (!path || !sessionId) return
      restoreFocus.current = false
      onOpenChange(false)
      requestWorkspaceFile(sessionId, path)
    } else {
      const action = filtered[index]
      if (!action) return
      if (action.id === 'composer') restoreFocus.current = false
      onOpenChange(false)
      action.run()
    }
  }
  return (
    <div ref={dialogRef} className="fixed inset-0 z-[80] flex items-start justify-center bg-[color:var(--color-overlay)] px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette"
      onClick={event => { if (event.target === event.currentTarget) onOpenChange(false) }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onOpenChange(false) }
        if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(index => Math.min(index + 1, Math.max(count - 1, 0))) }
        if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(index => Math.max(index - 1, 0)) }
        if (event.key === 'Enter') { event.preventDefault(); run(selected) }
        if (event.key === 'Tab') { event.preventDefault(); inputRef.current?.focus() }
      }}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-outline bg-surface-raised shadow-2xl">
        <div className="flex items-center gap-3 border-b border-outline px-4">
          <Search className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setSelected(0) }} placeholder={fileMode ? 'Search workspace files… (> for actions)' : 'Search actions...'} aria-label={fileMode ? 'Search workspace files' : 'Search commands'} aria-controls={resultsId} aria-activedescendant={count ? `${resultsId}-${selected}` : undefined} className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none" />
          <kbd className="hidden rounded border border-outline px-1.5 py-0.5 text-xs text-muted-foreground sm:block">Esc</kbd>
        </div>
        {sessionId && <p className="px-4 py-2 text-xs text-muted-foreground">{fileMode ? 'Files in this session’s workspace · Type > for actions' : 'Actions · Remove > to search files'}</p>}
        <div id={resultsId} role="listbox" aria-label={fileMode ? 'File results' : 'Command results'} className="max-h-[min(60vh,20rem)] overflow-y-auto p-2">
          {fileMode && !currentSearch && <p role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">Searching files…</p>}
          {fileMode && currentSearch?.error && <p role="alert" className="px-3 py-4 text-sm">{currentSearch.error}</p>}
          {count === 0 && (!fileMode || (currentSearch && !currentSearch.error)) && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{fileMode ? 'No matching files' : 'No matching actions'}</p>}
          {(fileMode ? paths.map(path => ({ id: path, label: path.split('/').pop()!, description: path, icon: File })) : filtered).map((action, index) => {
            const Icon = action.icon
            const shortcut = 'shortcut' in action && typeof action.shortcut === 'string' ? action.shortcut : undefined
            return <button key={action.id} id={`${resultsId}-${index}`} data-result-index={index} tabIndex={-1} type="button" role="option" aria-selected={selected === index} onMouseEnter={() => setSelected(index)} onClick={() => run(index)} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left', selected === index ? 'bg-accent text-accent-foreground' : 'text-foreground')}>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{action.label}</span><span className="block truncate text-xs text-muted-foreground">{action.description}</span></span>{shortcut && <kbd className="text-xs text-muted-foreground">{shortcut}</kbd>}<ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </button>
          })}
        </div>
        {fileMode && currentSearch?.truncated && <p role="status" className="border-t border-outline px-4 py-2 text-xs text-muted-foreground">Results limited to 100 files. Refine your search.</p>}
      </div>
    </div>
  )
}
