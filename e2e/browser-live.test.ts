import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PocketBase from 'pocketbase'
import { chromium } from 'playwright'
import { startHarness, type Harness } from './harness'
import { startBrowserFixture } from './browser-fixture'
import { startBrowserWorker } from '../packages/subpolar-browser/src/index'

const enabled = process.env.E2E_BROWSER_LIVE === 'true'
/** Fail on an unavailable service: opt-in verification must never become a false pass. */
test.skipIf(!enabled)('real browser, PocketBase, bridge, grants, controller and historical screenshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subpolar-browser-e2e-'))
  const fixture = startBrowserFixture()
  const token = 'test-browser-worker-secret-isolated-123456789'
  let worker = await startBrowserWorker({ profileRoot: join(root, 'profiles'), token, hostname: '127.0.0.1', port: 0, allowedPrivateHosts: ['127.0.0.1'] })
  let harness: Harness | undefined
  const previous = { url: process.env.SUBPOLAR_BROWSER_WORKER_URL, token: process.env.SUBPOLAR_BROWSER_WORKER_TOKEN }
  process.env.SUBPOLAR_BROWSER_WORKER_URL = `http://127.0.0.1:${worker.server.port}`
  process.env.SUBPOLAR_BROWSER_WORKER_TOKEN = token
  try {
    harness = await startHarness()
    const base = harness.bridgeUrl
    const request = async (path: string, method = 'GET', body?: unknown, cookie = '') => {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(65000) })
      const json = await response.json().catch(() => ({})) as any
      return { response, json }
    }
    const auth = await request('/api/auth/sign-in/email', 'POST', { email: 'e2e-admin@example.test', password: 'e2e-admin-password-16' })
    expect(auth.response.status).toBe(200)
    const cookie = auth.response.headers.get('set-cookie')!.split(';')[0]!
    const api = async (path: string, method = 'GET', body?: unknown) => { const r = await request(path, method, body, cookie); if (!r.response.ok) throw new Error(`${method} ${path}: ${r.response.status} ${JSON.stringify(r.json)}`); return r.json }
    const admin = new PocketBase(harness.pocketBaseUrl)
    await admin.collection('_superusers').authWithPassword('e2e-admin@example.test', 'e2e-admin-password-16')
    await admin.collection('users').create({ email: 'other-browser@example.test', password: 'other-browser-password-16', passwordConfirm: 'other-browser-password-16', name: 'Other test user' })
    const otherAuth = await request('/api/auth/sign-in/email', 'POST', { email: 'other-browser@example.test', password: 'other-browser-password-16' })
    expect(otherAuth.response.ok).toBe(true)
    const otherCookie = otherAuth.response.headers.get('set-cookie')!.split(';')[0]!
    const profile = (await api('/api/browser/profiles', 'POST', { name: 'Isolated login' })).profile
    expect(profile.id).toBeTruthy()
    expect((await request(`/api/browser/profiles/${profile.id}`, 'PATCH', { name: 'Forbidden' }, otherCookie)).response.ok).toBe(false)
    await api(`/api/browser/profiles/${profile.id}`, 'PATCH', { name: 'Renamed login' })
    expect((await api('/api/browser/profiles')).profiles.find((p: any) => p.id === profile.id).name).toBe('Renamed login')
    const piSession = (await api('/api/sessions', 'POST', { title: 'Browser E2E', agent: 'master' })).session
    expect(piSession.id).toBeTruthy()
    const scope = `?sessionId=${encodeURIComponent(piSession.id)}`
    const browser = (await api('/api/browser/sessions', 'POST', { sessionId: piSession.id, profileId: profile.id })).session
    const prefix = `/api/browser/sessions/${browser.id}`
    const busy = await request('/api/browser/sessions', 'POST', { sessionId: piSession.id, profileId: profile.id }, cookie)
    expect(busy.response.ok).toBe(false)
    const takeover = await api(prefix + '/control' + scope, 'POST', { action: 'take' })
    const leaseId = takeover.controller.leaseId
    const input = (operation: string, values: any = {}) => api(prefix + '/input' + scope, 'POST', { leaseId, operation, input: values })
    await input('open', { url: `http://127.0.0.1:${fixture.port}/` })
    await input('fill', { locator: { label: 'Username' }, value: 'fixture-user' })
    await input('fill', { locator: { label: 'Password' }, value: 'fixture-password' })
    await input('click', { locator: { role: 'button', name: 'Log in' } })
    const frame = await api(prefix + '/frame' + scope)
    expect(frame.frame.mimeType).toBe('image/png')
    expect(Buffer.from(frame.frame.data, 'base64').byteLength).toBeGreaterThan(100)
    expect((await request(prefix + '/frame' + scope)).response.status).toBe(401)
    expect((await request(prefix + '/frame' + scope, 'GET', undefined, otherCookie)).response.status).toBe(404)
    expect((await request(prefix + '/frame?sessionId=wrong', 'GET', undefined, cookie)).response.status).toBe(404)
    const stale = await request(prefix + '/input' + scope, 'POST', { leaseId: 'stale', operation: 'keyboard', input: { text: 'no' } }, cookie)
    expect(stale.response.ok).toBe(false)

    const agents = await api('/api/agents')
    const master = agents.find((a: any) => a.name === 'master')
    const agentPath = `/api/agents/${master.id}`
    await api(agentPath, 'PATCH', { policies: { ...master.policies, browser: true }, browser: { allowedProfileIds: [profile.id], defaultProfileId: profile.id, allowEphemeral: true }, approval_mode: 'auto' })
    const call = (toolId: string, values: any) => api('/api/subpolar-cli/tools/call', 'POST', { sessionId: piSession.id, toolId, callId: crypto.randomUUID(), input: { browserSessionId: browser.id, ...values } })
    const paused = await call('browser/read', {})
    expect(paused.ok).toBe(false)
    await api(prefix + '/control' + scope, 'POST', { action: 'release', leaseId })
    const result = await call('browser/read', {})
    expect(result.ok).toBe(true)
    const output = result.value ?? result.output ?? result.result ?? result.data
    expect(JSON.stringify(output)).toContain('Authenticated fixture')
    const screenshot = output.screenshotArtifact
    expect(screenshot.status).toBe('captured')
    expect((await fetch(base + screenshot.url, { headers: { cookie } })).ok).toBe(true)
    expect((await fetch(base + screenshot.url)).status).toBe(401)
    expect((await fetch(base + screenshot.url, { headers: { cookie: otherCookie } })).status).toBe(404)
    const failedNavigation = await call('browser/navigate', { url: 'file:///forbidden' })
    expect(failedNavigation.ok).toBe(false)
    const failedCapture = failedNavigation.error.details.screenshotArtifact
    expect(failedCapture.status).toBe('captured')
    expect((await fetch(base + failedCapture.url, { headers: { cookie } })).ok).toBe(true)
    await admin.collection('browser_screenshots').update(failedCapture.id, { expires_at: 1 })
    expect((await fetch(base + failedCapture.url, { headers: { cookie } })).status).toBe(404)
    await api('/api/browser/profiles')
    expect(await admin.collection('browser_screenshots').getOne(failedCapture.id).catch(() => null)).toBeNull()
    await api(agentPath, 'PATCH', { approval_mode: 'ask' })
    const approval = await call('browser/fill', { locator: { label: 'Message' }, value: 'Approved fixture value' })
    expect(approval.status).toBe('approval_required')
    const continued = await api(`/api/session/${piSession.id}/permissions/${approval.approvalId}`, 'POST', { response: 'approve' })
    expect(continued.result.ok).toBe(true)
    expect(JSON.stringify(await call('browser/snapshot', {}))).toContain('Approved fixture value')
    await api(agentPath, 'PATCH', { approval_mode: 'auto' })
    await api(agentPath, 'PATCH', { browser: { allowedProfileIds: [], allowEphemeral: true } })
    expect((await call('browser/read', {})).ok).toBe(false)
    await api(agentPath, 'PATCH', { policies: { ...master.policies, browser: false } })
    expect((await call('browser/read', {})).ok).toBe(false)
    const discovery = await api('/api/subpolar-cli/tools/list', 'POST', { sessionId: piSession.id })
    expect(JSON.stringify(discovery.tools)).not.toContain('browser/read')
    await api(prefix + '/close' + scope, 'POST')
    expect((await fetch(base + screenshot.url, { headers: { cookie } })).ok).toBe(true)

    const workerPort = worker.server.port
    await worker.close()
    worker = await startBrowserWorker({ profileRoot: join(root, 'profiles'), token, hostname: '127.0.0.1', port: workerPort, allowedPrivateHosts: ['127.0.0.1'] })
    const reopened = (await api('/api/browser/sessions', 'POST', { sessionId: piSession.id, profileId: profile.id })).session
    const reopenedPrefix = `/api/browser/sessions/${reopened.id}`
    const control = (await api(reopenedPrefix + '/control' + scope, 'POST', { action: 'take' })).controller
    await api(reopenedPrefix + '/input' + scope, 'POST', { leaseId: control.leaseId, operation: 'open', input: { url: `http://127.0.0.1:${fixture.port}/` } })
    await api(reopenedPrefix + '/control' + scope, 'POST', { action: 'release', leaseId: control.leaseId })
    await api(agentPath, 'PATCH', { policies: { ...master.policies, browser: true }, browser: { allowedProfileIds: [profile.id], defaultProfileId: profile.id } })
    const restored = await api('/api/subpolar-cli/tools/call', 'POST', { sessionId: piSession.id, toolId: 'browser/read', callId: crypto.randomUUID(), input: { browserSessionId: reopened.id } })
    expect(restored.ok).toBe(true)
    expect(JSON.stringify(restored)).toContain('Authenticated fixture')
    await api(reopenedPrefix + '/close' + scope, 'POST')
    const alternate = (await api('/api/browser/profiles', 'POST', { name: 'Alternate authorized profile' })).profile
    await api(agentPath, 'PATCH', { browser: { allowedProfileIds: [profile.id, alternate.id], defaultProfileId: profile.id } })
    const newAgentBrowser = async (input: any) => api('/api/subpolar-cli/tools/call', 'POST', { sessionId: piSession.id, toolId: 'browser/session', callId: crypto.randomUUID(), input })
    const defaultBrowser = await newAgentBrowser({})
    expect(defaultBrowser.ok).toBe(true)
    expect(defaultBrowser.value.session.profile_id).toBe(profile.id)
    expect(defaultBrowser.value.screenshotArtifact.status).toBe('captured')
    const alternateBrowser = await newAgentBrowser({ profileId: alternate.id })
    expect(alternateBrowser.ok).toBe(true)
    expect(alternateBrowser.value.session.profile_id).toBe(alternate.id)
    await api(`/api/browser/sessions/${defaultBrowser.value.session.id}/close` + scope, 'POST')
    await api(`/api/browser/sessions/${alternateBrowser.value.session.id}/close` + scope, 'POST')
    await api(`/api/browser/profiles/${alternate.id}`, 'DELETE')
    const project = await api('/api/projects', 'POST', { name: 'Browser scope fixture' })
    const projectRecord = await admin.collection('projects').getFirstListItem('name = "Browser scope fixture"')
    const projectPiSession = (await api('/api/sessions', 'POST', { project: project.id, title: 'Project browser scope', agent: 'master' })).session
    const projectBrowser = (await api('/api/browser/sessions', 'POST', { sessionId: projectPiSession.id })).session
    expect(projectBrowser.project_id).toBe(projectRecord.id)
    const projectScope = `?sessionId=${encodeURIComponent(projectPiSession.id)}`
    expect((await api(`/api/browser/sessions/${projectBrowser.id}` + projectScope)).session.id).toBe(projectBrowser.id)
    expect((await request(`/api/browser/sessions/${projectBrowser.id}` + projectScope + '&projectId=wrong', 'GET', undefined, cookie)).response.status).toBe(404)
    await api(agentPath, 'PATCH', { project_overrides: { [projectRecord.id]: { policies: { browser: false } } } })
    const projectDenied = await api('/api/subpolar-cli/tools/call', 'POST', { sessionId: projectPiSession.id, toolId: 'browser/read', callId: crypto.randomUUID(), input: { browserSessionId: projectBrowser.id } })
    expect(projectDenied.ok).toBe(false)
    await api(`/api/browser/sessions/${projectBrowser.id}/close` + projectScope, 'POST')
    await api(`/api/browser/profiles/${profile.id}/clear`, 'POST')
    await api(`/api/browser/profiles/${profile.id}`, 'DELETE')
    expect((await api('/api/browser/profiles')).profiles.some((p: any) => p.id === profile.id)).toBe(false)

    const auditRows = await admin.collection('subpolar_tool_audits').getFullList()
    expect(JSON.stringify(auditRows)).not.toContain('Approved fixture value')
    expect(JSON.stringify(auditRows)).not.toContain('fixture-password')
    const records = await admin.collection('browser_screenshots').getFullList()
    expect(records.some(r => r.browser_session_id === browser.id && r.tool_call_id)).toBe(true)
    // Verify the actual React application, not just a component mock or API.
    const uiBrowser = await chromium.launch({ headless: true, chromiumSandbox: true })
    try {
      const context = await uiBrowser.newContext()
      const separator = cookie.indexOf('=')
      await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: harness.baseUrl }])
      const page = await context.newPage()
      page.setDefaultTimeout(10000)
      page.on('pageerror', e => console.error('UI error:', e.message))
      await page.goto(harness.baseUrl + '/settings')
      await page.getByRole('button', { name: 'Browser Profiles', exact: true }).click()
      await page.locator('input[aria-label="New profile name"]:visible').fill('UI verification profile')
      await page.getByRole('button', { name: 'Create profile', exact: true }).click()
      await page.getByLabel('Rename UI verification profile').waitFor()
      await page.getByRole('button', { name: 'Open to log in', exact: true }).click()
      await page.getByRole('button', { name: 'New browser window', exact: true }).click()
      await page.getByRole('button', { name: 'Take control', exact: true }).click()
      await page.getByLabel('Browser address').fill(`http://127.0.0.1:${fixture.port}/`)
      await page.getByRole('button', { name: 'Go', exact: true }).click()
      await page.getByAltText('Live remote browser').waitFor()
      await page.getByRole('button', { name: 'Return control', exact: true }).click()
      await page.getByRole('button', { name: 'Close browser session', exact: true }).click()
      await page.getByRole('button', { name: 'Close viewer', exact: true }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await page.getByRole('button', { name: 'Confirm delete', exact: true }).click()
      await page.getByLabel('Rename UI verification profile').waitFor({ state: 'detached' })
      await context.close()
    } finally { await uiBrowser.close() }
    console.log('LIVE browser verified: real Chromium, isolated PB/bridge, manual login/control, grants and revocation, restart persistence, historical protected screenshot files, real React profile/viewer UI')
  } finally {
    await harness?.cleanup()
    await worker.close()
    fixture.stop(true)
    for (const [key, value] of Object.entries({ SUBPOLAR_BROWSER_WORKER_URL: previous.url, SUBPOLAR_BROWSER_WORKER_TOKEN: previous.token })) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(root, { recursive: true, force: true })
  }
}, 240000)
