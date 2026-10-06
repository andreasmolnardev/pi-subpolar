import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Bold,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  Clock3,
  Italic,
  ListTodo,
  Mail,
  MoreVertical,
  NotebookPen,
  Plus,
  Search,
  Trash2,
  Underline,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { settingsApi } from '@/api/settings'
import { productivityApi, type Note } from '@/api/productivity'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

const calendarColors = ['bg-sky-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500']
const tabs = [
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'todos', label: 'Todo', icon: CheckSquare },
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'notes', label: 'Notes', icon: NotebookPen },
] as const
const emptyNotes: Note[] = []

type ProductivityTab = typeof tabs[number]['id']

function formatEventTime(start: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(start))
}

function formatUpdatedAt(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

function getNotePreview(text: string) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function ProductivitySidebar() {
  const [expanded, setExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<ProductivityTab>('calendar')
  const activeApp = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]
  const ActiveAppIcon = activeApp.icon
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['productivity-calendar-upcoming'],
    queryFn: settingsApi.getUpcomingCalendarEvents,
    enabled: expanded && activeTab === 'calendar',
    staleTime: 60_000,
  })

  const calendars = data?.calendars ?? []
  const events = data?.events ?? []

  return (
    <aside
      className={cn(
        'hidden md:flex h-dvh flex-shrink-0 flex-col border-l border-border bg-card/60 backdrop-blur-sm pt-safe pb-safe transition-[width] duration-200',
        expanded ? 'w-[360px] max-w-[40vw]' : 'w-20'
      )}
      aria-label="Productivity integrations"
    >
      {expanded ? (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-accent"
                  aria-label="Switch productivity app"
                >
                  <ActiveAppIcon className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate">{activeApp.label}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                {tabs.map((tab) => {
                  const Icon = tab.icon
                  return (
                    <DropdownMenuItem key={tab.id} onClick={() => setActiveTab(tab.id)} className="gap-2">
                      <Icon className="h-4 w-4" />
                      {tab.label}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setExpanded(false)}
              aria-label="Close productivity sidebar"
              className="h-8 w-8 shrink-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {activeTab === 'calendar' && (
              <CalendarPanel
                calendars={calendars}
                events={events}
                isLoading={isLoading}
                isError={isError}
                error={error}
              />
            )}
            {activeTab === 'todos' && <TodoPanel />}
            {activeTab === 'email' && <EmailPanel />}
            {activeTab === 'notes' && <NotesPanel />}
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col gap-2 p-3">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id)
                  setExpanded(true)
                }}
                className="flex flex-col items-center gap-1 rounded-lg p-3 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Icon className="h-5 w-5 shrink-0 text-primary" />
                <span className="truncate">{tab.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </aside>
  )
}

function CalendarPanel({
  calendars,
  events,
  isLoading,
  isError,
  error,
}: {
  calendars: Array<{ id: string; name: string; url: string }>
  events: Array<{ title: string; calendar: string; start: string; end: string | null; location?: string }>
  isLoading: boolean
  isError: boolean
  error: unknown
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input placeholder="Search events" className="h-9" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="icon">
              <CalendarDays className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {calendars.map((calendar, index) => (
              <DropdownMenuItem key={calendar.id} className="gap-2">
                <span className={cn('h-2.5 w-2.5 rounded-full', calendarColors[index % calendarColors.length])} />
                <span className="truncate">{calendar.name}</span>
              </DropdownMenuItem>
            ))}
            {calendars.length === 0 && <DropdownMenuItem disabled>No calendars</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-col gap-2">
        {isLoading && <p className="px-1 text-sm text-muted-foreground">Loading upcoming events...</p>}
        {isError && <p className="px-1 text-sm text-destructive">{error instanceof Error ? error.message : 'Failed to load upcoming events'}</p>}
        {!isLoading && !isError && events.length === 0 && (
          <p className="px-1 text-sm text-muted-foreground">No upcoming events found.</p>
        )}
        {events.map((event) => (
          <article key={`${event.title}-${event.start}`} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-start gap-3">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium text-foreground">{event.title}</h3>
                <p className="truncate text-xs text-muted-foreground">{event.calendar}</p>
                <time className="mt-2 block text-xs text-muted-foreground">{formatEventTime(event.start)}</time>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

function TodoPanel() {
  const queryClient = useQueryClient()
  const [listName, setListName] = useState('')
  const [itemText, setItemText] = useState('')
  const [selectedListId, setSelectedListId] = useState('')
  const [isListDialogOpen, setIsListDialogOpen] = useState(false)
  const [isItemDialogOpen, setIsItemDialogOpen] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['productivity-todos'], queryFn: productivityApi.getTodos })
  const lists = data?.lists ?? []
  const items = data?.items ?? []
  const selectedList = lists.find((list) => list.id === selectedListId) ?? lists[0]
  const selectedItems = selectedList ? items.filter((item) => item.list_id === selectedList.id) : []
  const invalidateTodos = () => queryClient.invalidateQueries({ queryKey: ['productivity-todos'] })
  const createList = useMutation({
    mutationFn: productivityApi.createTodoList,
    onSuccess: (list) => {
      setListName('')
      setSelectedListId(list.id)
      setIsListDialogOpen(false)
      invalidateTodos()
    },
  })
  const deleteList = useMutation({
    mutationFn: productivityApi.deleteTodoList,
    onSuccess: () => {
      setSelectedListId('')
      invalidateTodos()
    },
  })
  const createItem = useMutation({
    mutationFn: ({ listId, text }: { listId: string; text: string }) => productivityApi.createTodoItem(listId, text),
    onSuccess: () => {
      setItemText('')
      setIsItemDialogOpen(false)
      invalidateTodos()
    },
  })
  const updateItem = useMutation({ mutationFn: ({ id, completed }: { id: string; completed: boolean }) => productivityApi.updateTodoItem(id, { completed }), onSuccess: invalidateTodos })
  const removeItem = useMutation({ mutationFn: productivityApi.deleteTodoItem, onSuccess: invalidateTodos })

  const submitList = (event: FormEvent) => {
    event.preventDefault()
    if (listName.trim()) createList.mutate(listName.trim())
  }

  const submitItem = (event: FormEvent) => {
    event.preventDefault()
    if (selectedList && itemText.trim()) createItem.mutate({ listId: selectedList.id, text: itemText.trim() })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="min-w-0 flex-1 justify-between">
              <span className="truncate">{selectedList?.name ?? 'Lists'}</span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {lists.map((list) => (
              <DropdownMenuItem key={list.id} onClick={() => setSelectedListId(list.id)}>
                {list.name}
              </DropdownMenuItem>
            ))}
            {lists.length === 0 && <DropdownMenuItem disabled>No lists</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" size="icon" onClick={() => setIsItemDialogOpen(true)} disabled={!selectedList}>
          <Plus className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setIsListDialogOpen(true)}>New list</DropdownMenuItem>
            {selectedList && (
              <DropdownMenuItem onClick={() => deleteList.mutate(selectedList.id)} className="text-destructive">
                Delete list
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-col gap-2">
        {isLoading && <p className="px-1 text-sm text-muted-foreground">Loading todos...</p>}
        {!isLoading && lists.length === 0 && <p className="px-1 text-sm text-muted-foreground">Create a list to start tracking todos.</p>}
        {selectedItems.map((item) => (
          <div key={item.id} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
            <Checkbox checked={item.completed} onCheckedChange={(checked) => updateItem.mutate({ id: item.id, completed: checked === true })} />
            <span className={cn('min-w-0 flex-1 text-sm', item.completed && 'text-muted-foreground line-through')}>{item.text}</span>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeItem.mutate(item.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {selectedList && selectedItems.length === 0 && <p className="px-1 text-sm text-muted-foreground">No todos in this list yet.</p>}
      </div>
      <Dialog open={isListDialogOpen} onOpenChange={setIsListDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New list</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitList} className="grid gap-4">
            <Input value={listName} onChange={(event) => setListName(event.target.value)} placeholder="List name" />
            <DialogFooter>
              <Button type="submit" disabled={createList.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={isItemDialogOpen} onOpenChange={setIsItemDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New todo</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitItem} className="grid gap-4">
            <Input value={itemText} onChange={(event) => setItemText(event.target.value)} placeholder="Todo" />
            <DialogFooter>
              <Button type="submit" disabled={createItem.isPending}>Add</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function EmailPanel() {
  const queryClient = useQueryClient()
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [mailForm, setMailForm] = useState({
    name: 'Mail',
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 587,
    username: '',
    password: '',
    fromAddress: '',
  })
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['productivity-mail-accounts'], queryFn: productivityApi.getMailAccounts })
  const accounts = data?.accounts ?? []
  const createMailIntegration = useMutation({
    mutationFn: () => settingsApi.createIntegration({
      id: crypto.randomUUID(),
      type: 'mail',
      enabled: true,
      name: mailForm.name.trim() || 'Mail',
      imapHost: mailForm.imapHost.trim(),
      imapPort: mailForm.imapPort,
      smtpHost: mailForm.smtpHost.trim(),
      smtpPort: mailForm.smtpPort,
      username: mailForm.username.trim(),
      password: mailForm.password,
      fromAddress: mailForm.fromAddress.trim() || mailForm.username.trim(),
    }),
    onSuccess: () => {
      setMailForm({
        name: 'Mail',
        imapHost: '',
        imapPort: 993,
        smtpHost: '',
        smtpPort: 587,
        username: '',
        password: '',
        fromAddress: '',
      })
      setIsDialogOpen(false)
      queryClient.invalidateQueries({ queryKey: ['productivity-mail-accounts'] })
      queryClient.invalidateQueries({ queryKey: ['settings-integrations'] })
    },
  })
  const updateMailForm = (field: keyof typeof mailForm, value: string | number) => {
    setMailForm((current) => ({ ...current, [field]: value }))
  }
  const submitMailForm = (event: FormEvent) => {
    event.preventDefault()
    if (!mailForm.imapHost.trim() || !mailForm.smtpHost.trim() || !mailForm.username.trim() || !mailForm.password) return
    createMailIntegration.mutate()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input placeholder="Search mail accounts" className="h-9" />
        <Button type="button" size="icon" onClick={() => setIsDialogOpen(true)}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {isLoading && <p className="px-1 text-sm text-muted-foreground">Loading mail accounts...</p>}
        {isError && <p className="px-1 text-sm text-destructive">{error instanceof Error ? error.message : 'Failed to load mail accounts'}</p>}
        {!isLoading && accounts.length === 0 && <p className="px-1 text-sm text-muted-foreground">No enabled IMAP/SMTP accounts configured.</p>}
        {accounts.map((account) => (
          <article key={account.id} className="rounded-lg border border-border bg-card p-3">
            <div className="mb-3">
              <h3 className="truncate text-sm font-medium text-foreground">{account.name}</h3>
              <p className="truncate text-xs text-muted-foreground">{account.fromAddress || account.username}</p>
            </div>
            <div className="flex flex-col gap-2">
              {account.folders.map((folder) => (
                <button key={folder.role} type="button" className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-accent">
                  <span className="truncate">{folder.name}</span>
                  {folder.role === 'inbox' && <span className="shrink-0 text-xs text-muted-foreground">Inbox</span>}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Email login</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitMailForm} className="grid gap-3">
            <Input value={mailForm.name} onChange={(event) => updateMailForm('name', event.target.value)} placeholder="Account name" />
            <Input value={mailForm.username} onChange={(event) => updateMailForm('username', event.target.value)} placeholder="Username" />
            <Input type="password" value={mailForm.password} onChange={(event) => updateMailForm('password', event.target.value)} placeholder="Password" />
            <Input type="email" value={mailForm.fromAddress} onChange={(event) => updateMailForm('fromAddress', event.target.value)} placeholder="From address" />
            <Input value={mailForm.imapHost} onChange={(event) => updateMailForm('imapHost', event.target.value)} placeholder="IMAP host" />
            <Input type="number" min={1} max={65535} value={mailForm.imapPort} onChange={(event) => updateMailForm('imapPort', Number(event.target.value) || 993)} placeholder="IMAP port" />
            <Input value={mailForm.smtpHost} onChange={(event) => updateMailForm('smtpHost', event.target.value)} placeholder="SMTP host" />
            <Input type="number" min={1} max={65535} value={mailForm.smtpPort} onChange={(event) => updateMailForm('smtpPort', Number(event.target.value) || 587)} placeholder="SMTP port" />
            <DialogFooter>
              <Button type="submit" disabled={createMailIntegration.isPending}>Save account</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NotesPanel() {
  const queryClient = useQueryClient()
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [search, setSearch] = useState('')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['productivity-notes'], queryFn: productivityApi.getNotes })
  const notes = data?.notes ?? emptyNotes
  const selectedNote = notes.find((note) => note.id === selectedNoteId)
  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return notes
    return notes.filter((note) => {
      const haystack = `${note.title} ${note.tags.join(' ')} ${getNotePreview(note.text)}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [notes, search])
  const invalidateNotes = () => queryClient.invalidateQueries({ queryKey: ['productivity-notes'] })
  const createNoteMutation = useMutation({
    mutationFn: productivityApi.createNote,
    onSuccess: (note) => {
      setSelectedNoteId(note.id)
      setIsCreateOpen(false)
      invalidateNotes()
    },
  })
  const updateNoteMutation = useMutation({ mutationFn: ({ id, note }: { id: string; note: { title: string; tags: string[]; text: string } }) => productivityApi.updateNote(id, note), onSuccess: invalidateNotes })
  const deleteNoteMutation = useMutation({
    mutationFn: productivityApi.deleteNote,
    onSuccess: () => {
      setSelectedNoteId('')
      invalidateNotes()
    },
  })

  if (selectedNote) {
    return (
      <NoteDetailScreen
        note={selectedNote}
        onBack={() => setSelectedNoteId('')}
        onSave={(note) => updateNoteMutation.mutate({ id: selectedNote.id, note })}
        onDelete={() => deleteNoteMutation.mutate(selectedNote.id)}
        isSaving={updateNoteMutation.isPending}
        isDeleting={deleteNoteMutation.isPending}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes" className="h-9 pl-9" />
        </div>
        <Button type="button" size="icon" onClick={() => setIsCreateOpen(true)}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {isLoading && <p className="px-1 text-sm text-muted-foreground">Loading notes...</p>}
        {filteredNotes.map((note) => (
          <button
            key={note.id}
            type="button"
            onClick={() => setSelectedNoteId(note.id)}
            className="rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent"
          >
            <span className="block truncate text-sm font-medium text-foreground">{note.title}</span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">{note.tags.join(', ') || formatUpdatedAt(note.updated_at)}</span>
            <span className="mt-2 line-clamp-2 text-xs text-muted-foreground">{getNotePreview(note.text) || 'No note text'}</span>
          </button>
        ))}
        {!isLoading && notes.length === 0 && <p className="px-1 text-sm text-muted-foreground">Create your first rich text note.</p>}
        {!isLoading && notes.length > 0 && filteredNotes.length === 0 && <p className="px-1 text-sm text-muted-foreground">No notes match your search.</p>}
      </div>
      <NoteEditorDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        title="Create note"
        submitLabel="Create"
        onSubmit={(note) => createNoteMutation.mutate(note)}
        isSubmitting={createNoteMutation.isPending}
      />
    </div>
  )
}

function NoteDetailScreen({
  note,
  onBack,
  onSave,
  onDelete,
  isSaving,
  isDeleting,
}: {
  note: Note
  onBack: () => void
  onSave: (note: { title: string; tags: string[]; text: string }) => void
  onDelete: () => void
  isSaving: boolean
  isDeleting: boolean
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState(note.title)
  const [tags, setTags] = useState(note.tags.join(', '))

  useEffect(() => {
    setTitle(note.title)
    setTags(note.tags.join(', '))
    if (editorRef.current) editorRef.current.innerHTML = note.text
  }, [note])

  const parsedTags = tags.split(',').map((tag) => tag.trim()).filter(Boolean)
  const format = (command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList') => {
    document.execCommand(command)
    editorRef.current?.focus()
  }
  const saveNote = () => {
    onSave({ title: title.trim() || 'Untitled note', tags: parsedTags, text: editorRef.current?.innerHTML ?? '' })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{note.title}</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onDelete} disabled={isDeleting} className="text-destructive">Delete note</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
      <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Tags, comma separated" />
      <div className="flex gap-1 overflow-x-auto">
        <Button type="button" variant="outline" size="icon-sm" onClick={() => format('bold')}><Bold className="h-4 w-4" /></Button>
        <Button type="button" variant="outline" size="icon-sm" onClick={() => format('italic')}><Italic className="h-4 w-4" /></Button>
        <Button type="button" variant="outline" size="icon-sm" onClick={() => format('underline')}><Underline className="h-4 w-4" /></Button>
        <Button type="button" variant="outline" size="icon-sm" onClick={() => format('insertUnorderedList')}><ListTodo className="h-4 w-4" /></Button>
      </div>
      <div
        ref={editorRef}
        contentEditable
        role="textbox"
        aria-label="Note text"
        className="min-h-80 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      />
      <Button type="button" onClick={saveNote} disabled={isSaving}>
        Save
      </Button>
    </div>
  )
}

function NoteEditorDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  onSubmit,
  isSubmitting,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  submitLabel: string
  onSubmit: (note: { title: string; tags: string[]; text: string }) => void
  isSubmitting: boolean
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [noteTitle, setNoteTitle] = useState('')
  const [tags, setTags] = useState('')

  useEffect(() => {
    if (!open) {
      setNoteTitle('')
      setTags('')
      if (editorRef.current) editorRef.current.innerHTML = ''
    }
  }, [open])

  const parsedTags = tags.split(',').map((tag) => tag.trim()).filter(Boolean)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit({ title: noteTitle.trim() || 'Untitled note', tags: parsedTags, text: editorRef.current?.innerHTML ?? '' })
  }
  const format = (command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList') => {
    document.execCommand(command)
    editorRef.current?.focus()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Input value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} placeholder="Title" />
          <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Tags, comma separated" />
          <div className="flex gap-1 overflow-x-auto">
            <Button type="button" variant="outline" size="icon-sm" onClick={() => format('bold')}><Bold className="h-4 w-4" /></Button>
            <Button type="button" variant="outline" size="icon-sm" onClick={() => format('italic')}><Italic className="h-4 w-4" /></Button>
            <Button type="button" variant="outline" size="icon-sm" onClick={() => format('underline')}><Underline className="h-4 w-4" /></Button>
            <Button type="button" variant="outline" size="icon-sm" onClick={() => format('insertUnorderedList')}><ListTodo className="h-4 w-4" /></Button>
          </div>
          <div
            ref={editorRef}
            contentEditable
            role="textbox"
            aria-label="Note text"
            className="min-h-48 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          />
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
