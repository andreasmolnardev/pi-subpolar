import { chromium, type BrowserContext, type Page, type Locator } from 'playwright'
import { mkdir, rm, open, readFile, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { createEgressProxy } from './network.ts'
export type BrowserLimits = { timeoutMs: number; maxPageBytes: number; maxTextBytes: number; maxTabs: number; maxRedirects: number }
export type BrowserTab = { id: string; url: string; title: string; text: string; status: number; openedAt: number }
export const DEFAULT_BROWSER_LIMITS: BrowserLimits = { timeoutMs: 15000, maxPageBytes: 4194304, maxTextBytes: 131072, maxTabs: 8, maxRedirects: 3 }
export class BrowserWorkerError extends Error { constructor(public code: string, message: string) { super(message) } }
type Session = { context: BrowserContext; pages: Map<string, Page>; current?: string; limits: BrowserLimits; touched: number; profileId?: string; lease?: FileHandle; leasePath?: string; queue: Promise<unknown> }
export type EngineOptions = { profileRoot: string; allowedPrivateHosts?: string[]; maxSessions?: number; idleMs?: number; executablePath?: string }
export class ChromiumBrowserPort {
  private sessions = new Map<string, Session>()
  private starting = new Set<string>()
  private downloads = new WeakSet<Page>()
  private proxyStarting?: Promise<Awaited<ReturnType<typeof createEgressProxy>>>
  private proxy?: Awaited<ReturnType<typeof createEgressProxy>>
  private timer: ReturnType<typeof setInterval>
  constructor(private options: EngineOptions) { this.timer = setInterval(() => { for (const [id,s] of this.sessions) if (Date.now() - s.touched > (options.idleMs ?? 900000)) void this.close(id) }, 30000); this.timer.unref() }
  private error(code: string, message: string): never { throw new BrowserWorkerError(code, message) }
  private limits(input: BrowserLimits): BrowserLimits { for (const [k,v] of Object.entries(input)) if (!Number.isInteger(v) || v < (k === 'maxRedirects' ? 0 : 1)) this.error('BROWSER_LIMIT','Invalid browser limits'); return { timeoutMs: Math.min(input.timeoutMs,60000), maxPageBytes: Math.min(input.maxPageBytes,16777216), maxTextBytes: Math.min(input.maxTextBytes,524288), maxTabs: Math.min(input.maxTabs,32), maxRedirects: Math.min(input.maxRedirects,10) } }
  private profile(id: string) { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) this.error('BROWSER_INVALID_INPUT','Invalid profile identifier'); return path.join(path.resolve(this.options.profileRoot), id) }
  async start(id: string, options: { profileId?: string; limits?: BrowserLimits } = {}) {
    if (this.sessions.has(id)) return { started: true }
    if (!id || id.length > 2048) this.error('BROWSER_INVALID_INPUT','Invalid session identifier')
    if (this.starting.has(id)) this.error('BROWSER_PROFILE_BUSY','Session is starting')
    if (this.sessions.size + this.starting.size >= (this.options.maxSessions ?? 4)) this.error('BROWSER_LIMIT','Browser session limit reached')
    this.starting.add(id)
    let lease: FileHandle | undefined; let leasePath: string | undefined; let launchingContext: BrowserContext | undefined
    try {
      const limits = this.limits(options.limits ?? DEFAULT_BROWSER_LIMITS)
      if (!this.proxyStarting) this.proxyStarting = createEgressProxy(this.options.allowedPrivateHosts); this.proxy = await this.proxyStarting
      await mkdir(this.options.profileRoot, { recursive: true, mode: 0o700 })
      if (options.profileId) { leasePath = this.profile(options.profileId) + '.lease'; try { try { const previous=JSON.parse(await readFile(leasePath,'utf8')); if(Number.isInteger(previous.pid)) { try { process.kill(previous.pid,0) } catch (e) { if((e as NodeJS.ErrnoException).code==='ESRCH') await rm(leasePath,{force:true}) } } } catch {} lease = await open(leasePath,'wx',0o600); await lease.writeFile(JSON.stringify({ pid: process.pid, session: id })) } catch { this.error('BROWSER_PROFILE_BUSY','Profile is already leased; stale leases require operator reconciliation') } }
      const args = ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking']
      const launch = { headless: true, chromiumSandbox: true, args, proxy: { server: this.proxy.url }, executablePath: this.options.executablePath, timeout: limits.timeoutMs }
      const context = options.profileId ? await chromium.launchPersistentContext(this.profile(options.profileId), { ...launch, viewport: { width: 1280, height: 720 }, acceptDownloads: true, serviceWorkers: 'block' }) : await (await chromium.launch(launch)).newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true, serviceWorkers: 'block' })
      launchingContext=context; const session: Session = { context, pages: new Map(), limits, touched: Date.now(), profileId: options.profileId, lease, leasePath, queue: Promise.resolve() }
      context.setDefaultTimeout(limits.timeoutMs); context.setDefaultNavigationTimeout(limits.timeoutMs)
      await context.route('**/*', async route => {
        const request = route.request(); let url: URL
        try { url = new URL(request.url()) } catch { return route.abort() }
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return route.abort('blockedbyclient')
        let redirects = 0; for (let r = request.redirectedFrom(); r; r = r.redirectedFrom()) redirects++
        if (redirects > limits.maxRedirects) return route.abort('blockedbyclient')
        return route.continue()
      })
      context.on('response', response => { const declared=Number(response.headers()['content-length'] ?? 0); if(declared>limits.maxPageBytes) void response.request().frame().page().close() });
      context.on('page', page => { if (session.pages.size >= limits.maxTabs) { void page.close(); return } const tabId = crypto.randomUUID(); session.pages.set(tabId,page); session.current = tabId; page.on('close', () => { session.pages.delete(tabId); if (session.current === tabId) session.current = session.pages.keys().next().value }); page.on('download', download => { if(!this.downloads.has(page)) void download.cancel() }) })
      for (const page of context.pages()) { const tabId = crypto.randomUUID(); session.pages.set(tabId,page); session.current = tabId }
      if(!session.pages.size) await context.newPage(); this.sessions.set(id,session); return { started: true }
    } catch (error) { const browser=launchingContext?.browser(); await launchingContext?.close().catch(()=>{}); await browser?.close().catch(()=>{}); await lease?.close(); if (leasePath && lease) await rm(leasePath,{force:true}); throw error } finally { this.starting.delete(id) }
  }
  private session(id: string) { const session = this.sessions.get(id); if (!session) this.error('BROWSER_SESSION_NOT_FOUND','Browser session not found'); session.touched = Date.now(); return session }
  private run<T>(id: string, fn: (s: Session) => Promise<T>): Promise<T> { const s = this.session(id); const next = s.queue.catch(() => {}).then(() => { if(this.sessions.get(id)!==s)this.error('BROWSER_SESSION_CLOSED','Browser session closed'); s.touched=Date.now(); return fn(s) }); s.queue = next; return next }
  private page(s: Session, tabId?: string) { const page = s.pages.get(tabId ?? s.current ?? ''); if (!page) this.error('BROWSER_SESSION_NOT_FOUND','Browser tab not found'); return page }
  private async tab(s: Session, page: Page, maxBytes = s.limits.maxTextBytes): Promise<BrowserTab> { const text = await page.locator('body').innerText({timeout: Math.min(s.limits.timeoutMs,2000)}).catch(() => ''); return { id: [...s.pages].find(([,p]) => p === page)![0], url: page.url(), title: await page.title(), text: new TextDecoder('utf-8',{fatal:false}).decode(Buffer.from(text).subarray(0,maxBytes)).replace(/\uFFFD$/,''), status: 200, openedAt: Date.now() } }
  async open(id: string,url: string,limits: BrowserLimits) { if (!this.sessions.has(id)) await this.start(id,{limits}); return this.run(id,async s => { if (s.pages.size >= s.limits.maxTabs) this.error('BROWSER_LIMIT','Tab limit reached'); const p = await s.context.newPage(); await p.goto(url==='about:blank'?url:this.url(url),{waitUntil:'domcontentloaded'}); return this.tab(s,p) }) }
  private url(url: string) { try { const u = new URL(url); if (!['https:','http:'].includes(u.protocol) || u.username || u.password) throw Error(); return u.href } catch { return this.error('BROWSER_POLICY','Only HTTP and HTTPS destinations are permitted') } }
  navigate(id: string,tabId: string,url: string,_limits: BrowserLimits) { return this.run(id,async s => { const p = this.page(s,tabId); await p.goto(this.url(url),{waitUntil:'domcontentloaded'}); return this.tab(s,p) }) }
  back(id: string,tabId: string) { return this.run(id,async s => { const p = this.page(s,tabId); await p.goBack({waitUntil:'domcontentloaded'}); return this.tab(s,p) }) }
  forward(id: string,tabId: string) { return this.run(id,async s => { const p = this.page(s,tabId); await p.goForward({waitUntil:'domcontentloaded'}); return this.tab(s,p) }) }
  async tabs(id: string) { if (!this.sessions.has(id)) return []; return this.run(id,s => Promise.all([...s.pages.values()].map(p => this.tab(s,p)))) }
  read(id: string,tabId?: string,maxBytes?: number) { return this.run(id,s => this.tab(s,this.page(s,tabId),Math.min(maxBytes ?? s.limits.maxTextBytes,s.limits.maxTextBytes))) }
  async find(id: string,query: string,tabId?: string) { if (!query) this.error('BROWSER_INVALID_INPUT','Search query is required'); const tab = await this.read(id,tabId); const matches = []; let index = tab.text.toLowerCase().indexOf(query.toLowerCase()); while (index >= 0 && matches.length < 100) { matches.push({index,text:tab.text.slice(Math.max(0,index-80),index+query.length+80)}); index = tab.text.toLowerCase().indexOf(query.toLowerCase(),index+query.length) } return {query,matches} }
  screenshot(id: string,tabId?: string) { return this.run(id,async s => ({mimeType:'image/png',data:(await this.page(s,tabId).screenshot({type:'png',timeout:s.limits.timeoutMs})).toString('base64')})) }
  wait(id: string,milliseconds: number) { return this.run(id,async s => { if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > s.limits.timeoutMs) this.error('BROWSER_LIMIT','Invalid wait duration'); await this.page(s).waitForTimeout(milliseconds); return {waitedMs:milliseconds} }) }
  private locator(p: Page,input: Record<string,any>): Locator { const l = input.locator ?? input; if (l.role) return p.getByRole(l.role,{name:l.name,exact:true}); if (l.label) return p.getByLabel(l.label,{exact:true}); if (l.text) return p.getByText(l.text,{exact:true}); if (typeof l.selector === 'string' && l.selector.length <= 2048) return p.locator(l.selector); return this.error('BROWSER_INVALID_INPUT','A semantic locator is required') }
  action(id: string,operation: string,input: Record<string,any> = {},tabId?: string) { return this.run(id,async s => {
    const p = this.page(s,tabId); const text = (v: unknown) => { if (typeof v !== 'string' || v.length > 65536) this.error('BROWSER_INVALID_INPUT','Invalid text input'); return v as string }
    const number = (v: unknown,max: number) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v)>max) this.error('BROWSER_INVALID_INPUT','Invalid coordinate'); return v as number }
    if (operation === 'snapshot') return { ...(await this.tab(s,p)), snapshot: (await p.locator('body').ariaSnapshot()).slice(0,s.limits.maxTextBytes) }
    if (operation === 'select-tab') { s.current = tabId; await p.bringToFront() }
    else if (operation === 'close-tab') await p.close()
    else if (operation === 'reload') await p.reload({waitUntil:'domcontentloaded'})
    else if (operation === 'resize') { const width=number(input.width,2560),height=number(input.height,1440); if (width<320||height<240) this.error('BROWSER_INVALID_INPUT','Invalid viewport'); await p.setViewportSize({width:Math.trunc(width),height:Math.trunc(height)}) }
    else if (operation === 'scroll') await p.mouse.wheel(number(input.deltaX ?? 0,10000),number(input.deltaY ?? input.y ?? 0,10000))
    else if (operation === 'pointer') { const x=number(input.x,2560),y=number(input.y,1440),viewport=p.viewportSize()!; if(x<0||y<0||x>viewport.width||y>viewport.height) this.error('BROWSER_INVALID_INPUT','Pointer is outside viewport'); if(input.type==='move') await p.mouse.move(x,y); else await p.mouse.click(x,y,{clickCount: input.clickCount===2?2:1, button: ['left','right','middle'].includes(input.button)?input.button:'left'}) }
    else if (operation === 'keyboard') { if(input.text !== undefined) await p.keyboard.insertText(text(input.text)); else await p.keyboard.press(text(input.key)) }
    else { const l=this.locator(p,input); if (operation==='click') await l.click(); else if(operation==='double-click') await l.dblclick(); else if(operation==='hover') await l.hover(); else if(operation==='fill') await l.fill(text(input.value ?? input.text)); else if(operation==='type') await l.pressSequentially(text(input.text ?? input.value)); else if(operation==='press') await l.press(text(input.key)); else if(operation==='select-option') await l.selectOption(text(input.value)); else if(operation==='check') await l.check(); else if(operation==='uncheck') await l.uncheck(); else if(operation==='download') { this.downloads.add(p); try { const [download]=await Promise.all([p.waitForEvent('download'),l.click()]); const stream=await download.createReadStream(); if(!stream)this.error('BROWSER_UNAVAILABLE','Download unavailable'); const parts:Buffer[]=[]; let size=0; for await(const chunk of stream){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>s.limits.maxPageBytes){stream.destroy();await download.cancel();this.error('BROWSER_LIMIT','Download size exceeded')}parts.push(bytes)}return {name:download.suggestedFilename(),mimeType:'application/octet-stream',data:Buffer.concat(parts).toString('base64')} } finally { this.downloads.delete(p) } } else if(operation==='upload') { const file=input.file; if(!file || !/^[^/\\]{1,255}$/.test(file.name)||typeof file.data!=='string'||file.data.length>s.limits.maxPageBytes*1.4) this.error('BROWSER_INVALID_INPUT','Invalid authorized upload'); const buffer=Buffer.from(file.data,'base64'); if(buffer.length>s.limits.maxPageBytes)this.error('BROWSER_LIMIT','Upload size exceeded'); await l.setInputFiles({name:file.name,mimeType:typeof file.mimeType==='string'?file.mimeType:'application/octet-stream',buffer}) } else if(operation==='drag') await l.dragTo(this.locator(p,input.target ?? {})); else this.error('BROWSER_INVALID_INPUT','Unsupported browser action') }
    return {ok:true,...(p.isClosed()?{}:await this.tab(s,p))}
  }) }
  async close(id: string) { const s=this.sessions.get(id); if(!s)return; this.sessions.delete(id); const browser=s.context.browser(); try { await s.context.close(); if(!s.profileId) await browser?.close() } finally { await s.lease?.close(); if(s.leasePath) await rm(s.leasePath,{force:true}) } }
  async clearProfile(id: string) { const directory=this.profile(id); let lease: FileHandle; try { lease=await open(directory+'.lease','wx',0o600) } catch { return this.error('BROWSER_PROFILE_BUSY','Profile is leased') } try { await rm(directory,{recursive:true,force:true}) } finally { await lease.close(); await rm(directory+'.lease',{force:true}) } }
  async health() { return {available:true,sessions:this.sessions.size,maxSessions:this.options.maxSessions??4,sessionIds:[...this.sessions.keys()]} }
  async dispose() { clearInterval(this.timer); await Promise.all([...this.sessions.keys()].map(id=>this.close(id))); await this.proxy?.close() }
}
