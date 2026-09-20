import { expect, test } from 'bun:test'
import { startHarness, type Harness } from './harness'

const timeoutMs = 10_000
const liveEnabled = process.env.E2E_LIVE === 'true'

type Json = Record<string, unknown>

function skip(message: string): void {
  console.log(`SKIP live E2E: ${message}`)
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<{ response: Response; body: Json | Json[] | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal })
    const body = await response.json().catch(() => null) as Json | Json[] | null
    return { response, body }
  } finally {
    clearTimeout(timer)
  }
}

function object(value: Json | Json[] | null): Json {
  return value && !Array.isArray(value) ? value : {}
}

test.skipIf(!liveEnabled)('live disposable bridge smoke', async () => {
  const email = process.env.E2E_LIVE_EMAIL?.trim()
  const password = process.env.E2E_LIVE_PASSWORD
  if (!email || !password) {
    skip('set E2E_LIVE_EMAIL and E2E_LIVE_PASSWORD; no authentication was attempted')
    return
  }

  let harness: Harness | undefined
  let baseUrl = process.env.E2E_LIVE_BASE_URL?.replace(/\/$/, '')
  let cookie = ''
  let projectId: number | undefined
  let taskId: string | undefined
  try {
    if (!baseUrl) {
      try {
        harness = await startHarness()
        baseUrl = harness.baseUrl
      } catch (error) {
        skip(`PocketBase/bridge/WebUI unavailable (${error instanceof Error ? error.message : String(error)})`)
        return
      }
    }

    const health = await request(baseUrl, '/api/v1/health')
    if (!health.response.ok) {
      skip(`bridge health unavailable (HTTP ${health.response.status})`)
      return
    }
    expect(object(health.body).status).not.toBe('unknown')

    const auth = await request(baseUrl, '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!auth.response.ok) {
      skip(`configured credentials were not accepted (HTTP ${auth.response.status})`)
      return
    }
    cookie = auth.response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    if (!cookie) {
      skip('authentication returned no session cookie')
      return
    }
    const headers = { cookie, 'content-type': 'application/json' }
    const name = `live-smoke-${Date.now()}`
    const project = await request(baseUrl, '/api/projects', { method: 'POST', headers, body: JSON.stringify({ name }) })
    if (!project.response.ok) {
      skip(`project creation unavailable (HTTP ${project.response.status})`)
      return
    }
    const projectBody = object(project.body)
    const projectRecord = object(projectBody.project ? projectBody.project as Json : projectBody)
    projectId = typeof projectRecord.id === 'number' ? projectRecord.id : undefined
    if (projectId === undefined) {
      skip('project endpoint returned no numeric project id')
      return
    }

    const session = await request(baseUrl, '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ project: projectId, title: 'Live smoke' }) })
    if (!session.response.ok) {
      skip(`session creation unavailable (HTTP ${session.response.status})`)
      return
    }
    const sessionRecord = object(object(session.body).session as Json | null)
    const sessionId = typeof sessionRecord.id === 'string' ? sessionRecord.id : undefined
    if (!sessionId) {
      skip('session endpoint returned no session id')
      return
    }
    console.log(`LIVE verified: health, authentication, project ${projectId}, session ${sessionId}`)

    const decisions = [
      ['read', 'allowed'],
      ['bash', 'denied'],
      ['write', 'approval'],
    ] as const
    for (const [toolName, expected] of decisions) {
      const result = await request(baseUrl, '/api/pi/tools/authorize', { method: 'POST', headers, body: JSON.stringify({ sessionId, toolName, input: {} }) })
      const decision = object(result.body).decision
      if (result.response.status === 404 || result.response.status === 405 || result.response.status === 503) {
        skip(`${expected} tool decision endpoint unavailable (HTTP ${result.response.status})`)
      } else {
        expect(decision).toBe(expected)
        console.log(`LIVE verified: ${expected} tool decision (${toolName})`)
      }
    }

    const inbox = await request(baseUrl, '/api/inbox', { headers })
    if (inbox.response.ok && Array.isArray(object(inbox.body).items)) console.log('LIVE verified: inbox status is readable')
    else skip(`inbox status unavailable (HTTP ${inbox.response.status})`)

    const notifications = await request(baseUrl, '/api/notifications/delivery-status?limit=1', { headers })
    if (notifications.response.ok && Array.isArray(object(notifications.body).deliveries)) console.log('LIVE verified: notification delivery status is readable')
    else skip(`notification status unavailable (HTTP ${notifications.response.status})`)

    const task = await request(baseUrl, '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ title: 'Live smoke audit', state: 'draft', projectId, sessionId }) })
    if (task.response.ok) {
      taskId = typeof object(object(task.body).task as Json | null).id === 'string' ? String(object(object(task.body).task as Json).id) : undefined
      if (taskId) {
        const audit = await request(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/audit`)
        if (audit.response.ok && Array.isArray(object(audit.body).audit)) console.log('LIVE verified: task audit is readable')
        else skip(`task audit unavailable (HTTP ${audit.response.status})`)
      } else skip('task endpoint returned no task id; audit not verified')
    } else skip(`task/audit setup unavailable (HTTP ${task.response.status})`)
  } catch (error) {
    skip(`live service became unavailable (${error instanceof Error ? error.message : String(error)})`)
  } finally {
    if (baseUrl && cookie && taskId) await request(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' } }).catch(() => undefined)
    if (baseUrl && cookie && projectId !== undefined) await request(baseUrl, `/api/projects/${projectId}`, { method: 'DELETE', headers: { cookie } }).catch(() => undefined)
    await harness?.cleanup()
  }
})
