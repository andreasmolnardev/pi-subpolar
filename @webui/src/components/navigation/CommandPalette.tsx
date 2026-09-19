import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Folder, History, MessageSquarePlus, Search } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'

export interface PaletteAction {
  id: string
  label: string
  description: string
  shortcut?: string
  icon: typeof Search
  run: () => void
}

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const actions = useMemo<PaletteAction[]>(() => {
    const focusComposer = () => document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    const result: PaletteAction[] = [
      { id: 'new', label: 'New chat', description: 'Start a fresh session', shortcut: 'N', icon: MessageSquarePlus, run: () => navigate('/new') },
      { id: 'sessions', label: 'Search sessions', description: 'Find a previous conversation', shortcut: 'S', icon: History, run: () => navigate('/history') },
      { id: 'projects', label: 'Switch project', description: 'Open the project list', icon: Folder, run: () => navigate('/projects') },
    ]
    if (document.querySelector('textarea')) {
      result.push({ id: 'composer', label: 'Focus composer', description: 'Jump to the message field', shortcut: '⌘↵', icon: Search, run: focusComposer })
    }
    return result.filter((action) => action.id !== 'composer' || location.pathname.includes('/sessions/'))
  }, [location.pathname, navigate])

  const filtered = actions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(query.trim().toLowerCase()))

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => setSelected((index) => Math.min(index, Math.max(filtered.length - 1, 0))), [filtered.length])

  if (!open) return null
  const runSelected = () => {
    const action = filtered[selected]
    if (!action) return
    onOpenChange(false)
    action.run()
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-[color:var(--color-overlay)] px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-outline bg-surface-raised shadow-2xl">
        <div className="flex items-center gap-3 border-b border-outline px-4">
          <Search className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0) }} onKeyDown={(event) => {
            if (event.key === 'Escape') onOpenChange(false)
            if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((index) => Math.min(index + 1, filtered.length - 1)) }
            if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((index) => Math.max(index - 1, 0)) }
            if (event.key === 'Enter') { event.preventDefault(); runSelected() }
          }} placeholder="Search actions..." aria-label="Search commands" className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none" />
          <kbd className="hidden rounded border border-outline px-1.5 py-0.5 text-xs text-muted-foreground sm:block">Esc</kbd>
        </div>
        <div role="listbox" aria-label="Command results" className="max-h-[min(60vh,20rem)] overflow-y-auto p-2">
          {filtered.length === 0 ? <p className="px-3 py-8 text-center text-sm text-muted-foreground">No matching actions</p> : filtered.map((action, index) => {
            const Icon = action.icon
            return <button key={action.id} type="button" role="option" aria-selected={selected === index} onMouseEnter={() => setSelected(index)} onClick={() => { onOpenChange(false); action.run() }} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left', selected === index ? 'bg-accent text-accent-foreground' : 'text-foreground')}>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{action.label}</span><span className="block truncate text-xs text-muted-foreground">{action.description}</span></span>{action.shortcut && <kbd className="text-xs text-muted-foreground">{action.shortcut}</kbd>}<ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </button>
          })}
        </div>
      </div>
    </div>
  )
}
