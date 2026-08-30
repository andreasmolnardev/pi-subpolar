import { useEffect, useRef, useState, type FormEvent } from 'react'
import { messageParts, piApi, sessionEventsUrl, type PiMessage, type Project, type RpcEvent, type Session } from './pi'

type RpcState = {
  model?: { provider?: string; id?: string; name?: string }
  thinkingLevel?: string
  isStreaming?: boolean
  messageCount?: number
  contextUsage?: { tokens?: number; contextWindow?: number; percent?: number }
}

type RpcModel = { provider?: string; id?: string; name?: string; reasoning?: boolean }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function MessageCard({ message }: { message: PiMessage }) {
  const role = message.role === 'assistant' ? 'pi' : message.role === 'toolResult' ? 'tool' : 'you'
  return (
    <article className={`message message-${role}`}>
      <div className="message-label">{role === 'pi' ? 'PI' : role === 'tool' ? 'TOOL' : 'YOU'}</div>
      {messageParts(message).map((part, index) => (
        <div className={part.type === 'thinking' ? 'thinking' : part.type === 'tool' ? 'tool-output' : 'markdown'} key={`${part.type}-${index}`}>
          {part.type === 'tool' ? <pre>{part.text}</pre> : <p>{part.text}</p>}
        </div>
      ))}
    </article>
  )
}

function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | undefined>()
  const [sessions, setSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | undefined>()
  const [messages, setMessages] = useState<PiMessage[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [thinkingText, setThinkingText] = useState('')
  const [activeTool, setActiveTool] = useState<string | undefined>()
  const [state, setState] = useState<RpcState>({})
  const [models, setModels] = useState<RpcModel[]>([])
  const [profiles, setProfiles] = useState<string[]>([])
  const [commands, setCommands] = useState<Array<{ name: string; description?: string }>>([])
  const [tools, setTools] = useState<string[]>([])
  const [usage, setUsage] = useState<number | undefined>()
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const socket = useRef<WebSocket | undefined>(undefined)

  useEffect(() => {
    piApi.projects().then((response) => {
      setProjects(response.projects)
      setProject(response.projects[0])
    }).catch((reason) => setError(errorText(reason)))
  }, [])

  useEffect(() => {
    if (!project) return
    piApi.sessions(project.name).then((response) => {
      setSessions(response.sessions)
      setSession(response.sessions[0])
    }).catch((reason) => setError(errorText(reason)))
  }, [project])

  useEffect(() => {
    const current = session
    if (!current) return
    let cancelled = false
    const load = async () => {
      try {
        const [messageResponse, stateResponse, modelResponse, profileResponse, commandResponse, toolResponse] = await Promise.all([
          piApi.messages(current.id),
          piApi.state(current.id),
          piApi.rpc(current.id, { type: 'get_available_models' }),
          piApi.profiles(),
          piApi.commands(current.id),
          piApi.tools(current.id),
        ])
        if (cancelled) return
        const messageList = messageResponse.data?.messages
        setMessages(Array.isArray(messageList) ? messageList as PiMessage[] : [])
        setState((stateResponse.data ?? {}) as RpcState)
        const available = modelResponse.data?.models
        setModels(Array.isArray(available) ? available as RpcModel[] : [])
        setProfiles(Object.keys(profileResponse.profiles))
        const availableCommands = commandResponse.data?.commands
        setCommands(Array.isArray(availableCommands) ? availableCommands as Array<{ name: string; description?: string }> : [])
        setTools(toolResponse.tools)
      } catch (reason) {
        if (!cancelled) setError(errorText(reason))
      }
    }
    void load()
    const nextSocket = new WebSocket(sessionEventsUrl(current.id))
    socket.current = nextSocket
    nextSocket.onmessage = (event) => {
      const value = JSON.parse(event.data) as RpcEvent
      if (value.type === 'agent_start') setBusy(true)
      if (value.type === 'agent_settled' || value.type === 'agent_end') {
        setBusy(false)
        setActiveTool(undefined)
        void piApi.messages(current.id).then((response) => {
          const list = response.data?.messages
          setMessages(Array.isArray(list) ? list as PiMessage[] : [])
          setStreamingText('')
          setThinkingText('')
        }).catch((reason) => setError(errorText(reason)))
      }
      if (value.type === 'message_update') {
        const update = value.assistantMessageEvent
        if (update?.type === 'text_delta' && update.delta) setStreamingText((text) => text + update.delta)
        if (update?.type === 'thinking_delta' && update.delta) setThinkingText((text) => text + update.delta)
      }
      if (value.type === 'tool_execution_start') setActiveTool(typeof value.toolName === 'string' ? value.toolName : 'working')
      if (value.type === 'tool_execution_end') setActiveTool(undefined)
    }
    nextSocket.onerror = () => setError('WebSocket connection to Pi failed')
    return () => {
      cancelled = true
      nextSocket.close()
      if (socket.current === nextSocket) socket.current = undefined
    }
  }, [session])

  const selectProject = (name: string) => {
    const next = projects.find((item) => item.name === name)
    if (next) setProject(next)
  }

  const newSession = async () => {
    if (!project) return
    try {
      const response = await piApi.createSession(project.name)
      setSessions((items) => [response.session, ...items])
      setSession(response.session)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!session || !draft.trim() || busy) return
    const message = draft.trim()
    setDraft('')
    setMessages((items) => [...items, { role: 'user', content: message, timestamp: Date.now() }])
    setStreamingText('')
    setThinkingText('')
    setBusy(true)
    try {
      await piApi.prompt(session.id, message)
    } catch (reason) {
      setBusy(false)
      setError(errorText(reason))
    }
  }

  const sendRpc = async (command: Record<string, unknown>) => {
    if (!session) return
    try {
      const response = await piApi.rpc(session.id, command)
      if (response.data) setState(response.data as RpcState)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const changeModel = (value: string) => {
    const [provider, ...modelParts] = value.split('/')
    if (provider && modelParts.length) void sendRpc({ type: 'set_model', provider, modelId: modelParts.join('/') })
  }

  const runExtensionCommand = (name: string) => {
    if (!session) return
    void piApi.rpc(session.id, { type: 'prompt', message: `/${name}` }).catch((reason) => setError(errorText(reason)))
  }

  const searchSessions = async (event: FormEvent) => {
    event.preventDefault()
    if (!search.trim()) return
    try {
      const result = await piApi.search(search.trim())
      setSessions(result.sessions)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">+</span><div><strong>PI / WEBUI</strong><small>RPC workspace</small></div></div>
        <label className="eyebrow" htmlFor="project">PROJECT ROOT</label>
        <select id="project" value={project?.name ?? ''} onChange={(event) => selectProject(event.target.value)}>
          {projects.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
        <div className="sidebar-row"><span className="eyebrow">SESSIONS</span><button className="icon-button" onClick={() => void newSession()} title="New session">+</button></div>
        <form className="search" onSubmit={searchSessions}><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search history" /><button type="submit">/</button></form>
        <div className="session-list">
          {sessions.map((item) => <button className={`session-item ${item.id === session?.id ? 'selected' : ''}`} key={item.id} onClick={() => setSession(item)}><span>{item.title}</span><small>{new Date(item.updatedAt).toLocaleDateString()}</small></button>)}
          {!sessions.length && <p className="empty">No saved sessions.</p>}
        </div>
        <div className="sidebar-footer"><span className="live-dot" /> bridge online <span className="mono">127.0.0.1:{window.location.port || '4173'}</span></div>
      </aside>

      <section className="conversation">
        <header className="topbar"><div><span className="eyebrow">ACTIVE SESSION</span><h1>{session?.title ?? 'Select a session'}</h1></div><div className="top-actions"><span className={busy ? 'status working' : 'status'}>{busy ? 'PI IS THINKING' : 'READY'}</span><button onClick={() => void sendRpc({ type: 'abort' })} disabled={!busy}>Abort</button></div></header>
        {error && <button className="error-banner" onClick={() => setError(undefined)}>{error} <span>close</span></button>}
        <div className="transcript">
          {!messages.length && !streamingText && <div className="welcome"><span className="welcome-line">DIRECT RPC CHANNEL</span><h2>Ask Pi anything.</h2><p>Prompts, tools, session state, and extensions stay inside your local Pi runtime.</p></div>}
          {messages.map((message, index) => <MessageCard message={message} key={`${message.timestamp ?? index}-${index}`} />)}
          {thinkingText && <article className="message message-pi"><div className="message-label">THINKING</div><div className="thinking"><p>{thinkingText}</p></div></article>}
          {streamingText && <article className="message message-pi"><div className="message-label">PI</div><div className="markdown"><p>{streamingText}</p></div></article>}
          {activeTool && <div className="tool-running"><span className="spinner" /> {activeTool} executing</div>}
        </div>
        <form className="composer" onSubmit={submit}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message Pi..." disabled={!session} /><div className="composer-footer"><span>Enter to send · Shift+Enter for newline</span><button className="send-button" type="submit" disabled={!session || !draft.trim() || busy}>SEND <span>↗</span></button></div></form>
      </section>

      <aside className="inspector">
        <div className="inspector-header"><span className="eyebrow">RUNTIME DECK</span><span className="runtime-dot" /></div>
        <section className="deck-section"><label className="eyebrow">MODEL</label><select value={state.model?.provider && state.model.id ? `${state.model.provider}/${state.model.id}` : ''} onChange={(event) => changeModel(event.target.value)}><option value="">Pi default</option>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? model.id}</option>)}</select><div className="stat-line"><span>Thinking</span><select value={state.thinkingLevel ?? 'medium'} onChange={(event) => void sendRpc({ type: 'set_thinking_level', level: event.target.value })}>{['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => <option key={level}>{level}</option>)}</select></div></section>
        <section className="deck-section"><label className="eyebrow">SESSION STATE</label><div className="metrics"><div><strong>{state.messageCount ?? messages.length}</strong><span>messages</span></div><div><strong>{state.contextUsage?.percent ?? 0}%</strong><span>context</span></div></div><button className="deck-button" onClick={() => void sendRpc({ type: 'compact' })}>Compact context</button><button className="deck-button" onClick={() => void piApi.rename(session?.id ?? '', prompt('Session title', session?.title) ?? '').then((result) => setSession(result.session)).catch((reason) => setError(errorText(reason)))} disabled={!session}>Rename session</button></section>
        <section className="deck-section"><label className="eyebrow">EXTENSIONS</label><div className="extension-list"><button onClick={() => void piApi.usage().then((result) => setUsage(result.sessions.length)).catch((reason) => setError(errorText(reason)))}>Usage report {usage === undefined ? '' : `· ${usage} sessions`}</button><button onClick={() => void piApi.activateProject(session?.id ?? '', project?.name ?? '').catch((reason) => setError(errorText(reason)))} disabled={!session || !project}>Activate project root</button>{profiles.map((profile) => <button key={profile} onClick={() => void piApi.activateProfile(session?.id ?? '', profile).catch((reason) => setError(errorText(reason)))} disabled={!session}>Profile: {profile}</button>)}</div></section>
        <section className="deck-section"><label className="eyebrow">PI COMMANDS</label><div className="command-list">{commands.slice(0, 8).map((command) => <button key={command.name} title={command.description} onClick={() => runExtensionCommand(command.name)}>{command.name}</button>)}</div><small className="tool-count">{tools.length} tools visible through extension bridge</small></section>
      </aside>
    </main>
  )
}

export default App
