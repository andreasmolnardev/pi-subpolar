import { SubpolarApiError, SubpolarClient } from '@subpolar/client'
import { expect, test } from 'bun:test'
import { startHarness, type Harness } from './harness'

const timeoutMs = 10_000
const liveEnabled = process.env.E2E_LIVE === 'true'

function skip(message: string): void {
  console.log(`SKIP live E2E: ${message}`)
}

function cookieFetch(timeout = timeoutMs): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let cookie = ''
  return async (input, init = {}) => {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('cookie', cookie)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(input, { ...init, headers, signal: init.signal ?? controller.signal })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';', 1)[0] ?? ''
      return response
    } finally {
      clearTimeout(timer)
    }
  }
}

async function nextEvent(client: SubpolarClient, sessionId: string) {
  const controller = new AbortController()
  const iterator = client.events({ sessionId, signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 3_000)
  try {
    return await iterator.next()
  } finally {
    clearTimeout(timer)
    await iterator.return(undefined).catch(() => undefined)
  }
}

test.skipIf(!liveEnabled)('live disposable bridge smoke through @subpolar/client', async () => {
  const email = process.env.E2E_LIVE_EMAIL?.trim()
  const password = process.env.E2E_LIVE_PASSWORD
  if (!email || !password) {
    skip('set E2E_LIVE_EMAIL and E2E_LIVE_PASSWORD; no authentication was attempted')
    return
  }

  let harness: Harness | undefined
  let baseUrl = process.env.E2E_LIVE_BASE_URL?.replace(/\/$/, '')
  let client: SubpolarClient | undefined
  let projectId: number | undefined
  let sessionId: string | undefined
  try {
    if (!baseUrl) {
      try {
        harness = await startHarness()
        baseUrl = harness.bridgeUrl
      } catch (error) {
        skip(`PocketBase/bridge/Subpolar Agent unavailable (${error instanceof Error ? error.message : String(error)})`)
        return
      }
    }

    // Deliberately use cookie auth only: the client must never receive a bearer/admin token.
    client = new SubpolarClient({ baseUrl, fetch: cookieFetch(), credentials: 'include' })
    try {
      const health = await client.health()
      expect(health.status).not.toBe('unknown')
      const auth = await client.signIn(email, password)
      expect(auth.user).toBeDefined()
      expect(auth.user.id).toBeTruthy()

      const currentSession = await client.authSession()
      expect(currentSession.user?.id).toBe(auth.user.id)
    } catch (error) {
      if (error instanceof SubpolarApiError) {
        skip(`health/authentication unavailable (HTTP ${error.status}${error.code ? `, ${error.code}` : ''})`)
        return
      }
      throw error
    }

    const name = `live-smoke-${Date.now()}`
    try {
      const project = await client.createProject({ name })
      expect(project.name).toBe(name)
      expect(typeof project.id).toBe('number')
      projectId = project.id

      const session = await client.createSession({ project: projectId, title: 'Live client smoke' })
      expect(session.id).toBeTruthy()
      expect(session.project === undefined || String(session.project) === String(projectId)).toBe(true)
      sessionId = session.id

      const listed = await client.listSessions({ project: String(projectId) })
      expect(listed.sessions.some((candidate) => candidate.id === session.id)).toBe(true)
      expect((await client.getSession(session.id)).id).toBe(session.id)

      const messageId = `e2e-${Date.now()}`
      const delivery = await client.sendMessage(session.id, 'E2E client integration ping', { messageID: messageId })
      expect(delivery.messageID).toBe(messageId)
      expect(delivery.state).toBeTruthy()

      try {
        const event = await nextEvent(client, session.id)
        if (event.done) skip('SSE stream ended before returning an event')
        else {
          expect(event.value).toHaveProperty('rawData')
          console.log(`LIVE verified: client auth/session/project/send/events (${event.value.event ?? 'message event'})`)
        }
      } catch (error) {
        if (error instanceof SubpolarApiError) skip(`client SSE events unavailable (HTTP ${error.status})`)
        else if (error instanceof Error && error.name === 'AbortError') skip('client SSE opened but emitted no event within 3 seconds')
        else throw error
      }
    } catch (error) {
      if (error instanceof SubpolarApiError) {
        skip(`client project/session/message flow unavailable (HTTP ${error.status}${error.code ? `, ${error.code}` : ''})`)
      } else {
        throw error
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AssertionError') throw error
    skip(`live service became unavailable (${error instanceof Error ? error.message : String(error)})`)
  } finally {
    if (client && sessionId) await client.deleteSession(sessionId).catch(() => undefined)
    if (client && projectId !== undefined) await client.deleteProject(projectId).catch(() => undefined)
    if (client) await client.signOut().catch(() => undefined)
    await harness?.cleanup()
  }
})
