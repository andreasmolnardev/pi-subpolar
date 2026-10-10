import { useEffect, useRef, useState } from 'react'
import { browserApi, type BrowserScope, type BrowserSession, type BrowserProfile, type BrowserController } from '@/api/browser'
import { useAuthGeneration, useAuthOwner } from '@/stores/authIdentityStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function LiveBrowser(props: { scope?: BrowserScope; enabled?: boolean; initialProfileId?: string }) {
  const owner = useAuthOwner(), generation = useAuthGeneration()
  return <BrowserViewer key={JSON.stringify([owner, generation, props.scope, props.initialProfileId])} {...props} />
}
function BrowserViewer({ scope = {}, enabled = true, initialProfileId = '' }: { scope?: BrowserScope; enabled?: boolean; initialProfileId?: string }) {
  const scopeKey = JSON.stringify(scope)
  const [sessions, setSessions] = useState<BrowserSession[]>([]), [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [profileId, setProfileId] = useState(initialProfileId), [session, setSession] = useState<BrowserSession | null>(null)
  const [connected, setConnected] = useState(false), [frame, setFrame] = useState(''), [address, setAddress] = useState('')
  const [controller, setController] = useState<BrowserController | null>(null), [error, setError] = useState(''), [pending, setPending] = useState(false)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), lastMove = useRef(0), [paste, setPaste] = useState('')
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false; clearTimeout(clickTimer.current) }, [])
  const lease = useRef<BrowserController | null>(null), viewport = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null)
  lease.current = controller
  const browserId = session?.id
  async function run(action: () => Promise<unknown>) { setPending(true); setError(''); try { await action() } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Browser request failed') } finally { if (mounted.current) setPending(false) } }
  useEffect(() => {
    if (!enabled) return
    let active = true
    void Promise.all([browserApi.sessions(JSON.parse(scopeKey)), browserApi.profiles()]).then(([s, p]) => { if (active) { setSessions(s.sessions.filter(s => s.lifecycle === 'open')); setProfiles(p.profiles) } }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [scopeKey, enabled])
  // One bounded frame request at a time, only while this viewer is visible and connected.
  useEffect(() => {
    if (!browserId || !connected || !enabled) { setFrame(''); return }
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
    const tick = async () => {
      try {
        if (document.visibilityState !== 'hidden') {
          const result = await browserApi.frame(browserId, JSON.parse(scopeKey), abort.signal)
          if (stopped) return
          if (/^image\/(png|jpeg|webp)$/.test(result.frame.mimeType) && result.frame.data.length <= 12 * 1024 * 1024) setFrame(`data:${result.frame.mimeType};base64,${result.frame.data}`)
          setSession(result.session)
        }
      } catch (e) { if (!stopped) { setError(e instanceof Error ? e.message : 'Viewer disconnected'); setConnected(false); setController(null) } }
      if (!stopped) timer = setTimeout(tick, 750)
    }
    void tick()
    return () => { stopped = true; abort.abort(); clearTimeout(timer); const current = lease.current; if (current) void browserApi.control(browserId, JSON.parse(scopeKey), 'release', current.leaseId).catch(() => {}); lease.current = null }
  }, [browserId, connected, enabled, scopeKey])
  useEffect(() => { setAddress(session?.current_url ?? '') }, [session?.current_url])
  useEffect(() => {
    if (!browserId || !controller || !connected || !enabled) return
    const timer = setInterval(() => { void browserApi.control(browserId, JSON.parse(scopeKey), 'renew', controller.leaseId).then(r => setController(r.controller)).catch(() => setController(null)) }, 10000)
    return () => clearInterval(timer)
  }, [browserId, controller?.leaseId, connected, enabled, scopeKey])
  async function input(operation: string, input: Record<string, unknown> = {}) {
    if (!browserId || !lease.current || !connected || !enabled) return
    const result = await browserApi.input(browserId, JSON.parse(scopeKey), lease.current.leaseId, operation, input)
    if (mounted.current) setSession(result.session)
  }
  useEffect(() => {
    if (!controller || !viewport.current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(entries => { clearTimeout(timer); const width = Math.round(entries[0].contentRect.width); timer = setTimeout(() => { void input('resize', { width: Math.max(320, Math.min(1920, width)), height: 720 }).catch(e => setError(e.message)) }, 300) })
    observer.observe(viewport.current)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [controller?.leaseId, browserId])
  async function disconnect() { const current = lease.current; if (browserId && current) await browserApi.control(browserId, JSON.parse(scopeKey), 'release', current.leaseId); setController(null); setConnected(false) }
  const controlled = !!controller && connected && enabled
  return <div className="flex h-full min-h-0 flex-col gap-3 p-3 text-sm">
    <p className="text-muted-foreground">Connect to a server browser to observe or log in. Take control to interact; return control when finished.</p>
    <div className="flex flex-wrap gap-2">
      <select aria-label="Browser profile" className="min-w-0 rounded border bg-background p-2" value={profileId} onChange={e => setProfileId(e.target.value)}><option value="">Ephemeral browser</option>{profiles.map(p => <option key={p.id} value={p.id} disabled={p.busy}>{p.name}{p.busy ? ' (in use)' : ''}</option>)}</select>
      <Button size="sm" disabled={pending} onClick={() => void run(async () => { const r = await browserApi.create(JSON.parse(scopeKey), profileId || undefined); setSession(r.session); setSessions(s => [r.session, ...s.filter(x => x.id !== r.session.id)]); setConnected(true) })}>New browser window</Button>
      <select aria-label="Attach browser session" value={browserId ?? ''} className="min-w-0 max-w-full rounded border bg-background p-2" onChange={e => { const id = e.target.value; void run(async () => { await disconnect(); setSession(sessions.find(s => s.id === id) ?? null) }) }}><option value="">Select existing session</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.current_url || s.id}</option>)}</select>
    </div>
    {session && <>
      <div className="flex flex-wrap items-center gap-2"><span role="status">{connected && enabled ? controlled ? 'Manual control' : 'Viewing' : 'Disconnected'}</span>
        {!connected ? <Button size="sm" onClick={() => setConnected(true)}>Connect viewer</Button> : <Button size="sm" variant="outline" onClick={() => void run(disconnect)}>Disconnect viewer</Button>}
        <Button size="sm" disabled={!connected || pending} onClick={() => void run(async () => { const result = await browserApi.control(session.id, JSON.parse(scopeKey), controller ? 'release' : 'take', controller?.leaseId); setController(result.controller) })}>{controller ? 'Return control' : 'Take control'}</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(async () => { await browserApi.close(session.id, JSON.parse(scopeKey)); setSession(null); setConnected(false); setController(null); setSessions(s => s.filter(x => x.id !== session.id)) })}>Close browser session</Button>
      </div>
      <form className="flex gap-1" onSubmit={e => { e.preventDefault(); void run(() => input(session.tabs.length ? 'navigate' : 'open', { url: address })) }}>
        {(['back', 'forward', 'reload'] as const).map(action => <Button key={action} type="button" size="sm" variant="outline" disabled={!controlled} aria-label={action} onClick={() => void run(() => input(action))}>{action === 'back' ? '←' : action === 'forward' ? '→' : '↻'}</Button>)}
        <Input aria-label="Browser address" value={address} onChange={e => setAddress(e.target.value)} disabled={!controlled} /><Button type="submit" size="sm" disabled={!controlled}>Go</Button>
      </form>
      <div className="flex flex-wrap gap-1">{session.tabs.map(tab => <span key={tab.id} className="flex max-w-full gap-1"><Button size="sm" variant={tab.id === session.current_tab_id ? 'secondary' : 'outline'} disabled={!controlled} onClick={() => void run(() => input('select-tab', { tabId: tab.id }))}>{tab.title || 'Untitled'}</Button><Button size="sm" variant="outline" aria-label={`Close tab ${tab.title}`} disabled={!controlled} onClick={() => void run(() => input('close-tab', { tabId: tab.id }))}>×</Button></span>)}<Button size="sm" disabled={!controlled} onClick={() => void run(() => input('open', { url: 'about:blank' }))}>New tab</Button></div>
      <div ref={viewport} tabIndex={controlled ? 0 : -1} role="application" aria-label="Remote browser viewport" className="min-h-32 flex-1 overflow-auto rounded border bg-muted focus:ring-2 focus:ring-primary"
        onKeyDown={e => { if (!controlled || e.nativeEvent.isComposing) return; e.preventDefault(); e.stopPropagation(); const key = [e.ctrlKey ? 'Control' : '', e.altKey ? 'Alt' : '', e.metaKey ? 'Meta' : '', e.shiftKey && e.key.length > 1 ? 'Shift' : '', e.key === ' ' ? 'Space' : e.key].filter(Boolean).join('+'); void run(() => input('keyboard', { key })) }}
        onWheel={e => { if (controlled) { e.preventDefault(); void input('scroll', { deltaX: e.deltaX, deltaY: e.deltaY }).catch(e => setError(e.message)) } }}
        onCompositionEnd={e => { if (controlled) void run(() => input('keyboard', { text: e.data })) }}
        onPointerMove={e => { if (!controlled || Date.now() - lastMove.current < 100 || !image.current) return; lastMove.current = Date.now(); const rect = image.current.getBoundingClientRect(); const x = (e.clientX - rect.left) * image.current.naturalWidth / rect.width, y = (e.clientY - rect.top) * image.current.naturalHeight / rect.height; if (x >= 0 && y >= 0 && x <= image.current.naturalWidth && y <= image.current.naturalHeight) void input('pointer', { x, y, type: 'move' }).catch(e => setError(e.message)) }}
        onClick={e => { if (!controlled || !image.current) return; e.currentTarget.focus(); const rect = image.current.getBoundingClientRect(); const x = (e.clientX - rect.left) * image.current.naturalWidth / rect.width, y = (e.clientY - rect.top) * image.current.naturalHeight / rect.height; if (x < 0 || y < 0 || x > image.current.naturalWidth || y > image.current.naturalHeight) return; clearTimeout(clickTimer.current); if (e.detail === 2) void run(() => input('pointer', { x, y, type: 'click', clickCount: 2 })); else clickTimer.current = setTimeout(() => { void run(() => input('pointer', { x, y, button: 'left', type: 'click' })) }, 220) }} onContextMenu={e => { if (!controlled || !image.current) return; e.preventDefault(); const rect = image.current.getBoundingClientRect(); const x = (e.clientX - rect.left) * image.current.naturalWidth / rect.width, y = (e.clientY - rect.top) * image.current.naturalHeight / rect.height; void run(() => input('pointer', { x, y, button: 'right', type: 'click' })) }}>
        {frame ? <img ref={image} src={frame} draggable={false} className="w-full" alt="Live remote browser" /> : <p className="p-4">{connected ? 'Waiting for browser frame…' : 'Viewer disconnected. The browser continues running.'}</p>}
      </div>
      {controlled && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void run(async () => { await input('keyboard', { text: paste }); setPaste('') }) }}><Input type="password" autoComplete="off" aria-label="Text to paste into browser" placeholder="Paste text into focused browser field" value={paste} onChange={e => setPaste(e.target.value)} /><Button size="sm" disabled={!paste}>Paste text</Button></form>}
    </>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>
}
