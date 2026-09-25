/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleAuthRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[0] === 'api' && path[1] === 'auth') {
    if (path[2] === 'session' && request.method === 'GET') {
      authenticatedUser = await deps.authenticateRequest(request)
      return deps.json({ user: authenticatedUser, token: null })
    }
    if (path[2] === 'config' && request.method === 'GET') {
      try { return deps.json(await deps.authConfig()) } catch (error) { console.warn(`Auth configuration unavailable: ${deps.redactedDiagnostic(error)}`); return deps.json({ message: 'PocketBase is unavailable' }, 503) }
    }
    if (path[2] === 'sign-out' && request.method === 'POST') {
      await deps.signOut()
      const response = deps.json({ success: true })
      response.headers.set('set-cookie', deps.clearAuthCookie())
      return response
    }
    if (path[2] === 'sign-in' && path[3] === 'email' && request.method === 'POST') {
      const input = await deps.body(request)
      if (typeof input.email !== 'string' || typeof input.password !== 'string') return deps.json({ message: 'Email and password are required' }, 400)
      try {
        const result = await deps.signIn(input.email, input.password)
        const response = deps.json({ token: result.token, user: result.user })
        response.headers.set('set-cookie', result.cookie)
        return response
      } catch (error) {
        return deps.json({ message: 'Invalid credentials' }, 401)
      }
    }
    if (path[2] === 'sign-up' && path[3] === 'email' && request.method === 'POST') {
      const input = await deps.body(request)
      if (typeof input.email !== 'string' || typeof input.password !== 'string' || typeof input.name !== 'string') return deps.json({ message: 'Name, email, and password are required' }, 400)
      try {
        const config = await deps.authConfig()
        if (!config.registrationEnabled && !(config.isFirstUser && !config.adminConfigured)) return deps.json({ message: 'Registration is disabled' }, 403)
        const result = await deps.signUp(input.email, input.password, input.name)
        const response = deps.json({ token: result.token, user: result.user }, 201)
        response.headers.set('set-cookie', result.cookie)
        return response
      } catch (error) {
        return deps.json({ message: 'Registration failed' }, 400)
      }
    }
    if (path[2] === 'change-password' && request.method === 'PUT') {
      if (!authenticatedUser) authenticatedUser = await deps.authenticateRequest(request)
      if (!authenticatedUser) return deps.json({ message: 'Not authenticated' }, 401)
      const input = await deps.body(request)
      if (typeof input.currentPassword !== 'string' || typeof input.newPassword !== 'string') return deps.json({ message: 'Current and new passwords are required' }, 400)
      try {
        await deps.changePassword(authenticatedUser.id, input.currentPassword, input.newPassword)
        return deps.json({ success: true })
      } catch (error) {
        return deps.json({ message: 'Failed to change password' }, 400)
      }
    }
  }

  if (url.pathname === '/api/suggestions' && request.method === 'POST') {
    if (!authenticatedUser) return deps.json({ error: 'Unauthorized' }, 401)
    const input = await deps.readJsonBody(request, 32 * 1024)
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    const assistantMessageId = typeof input.assistantMessageId === 'string' ? input.assistantMessageId.trim() : ''
    const lastUserText = typeof input.lastUserText === 'string' ? input.lastUserText.trim() : ''
    const lastAssistantText = typeof input.lastAssistantText === 'string' ? input.lastAssistantText.trim() : ''
    if (!sessionId || !assistantMessageId || !lastUserText || !lastAssistantText) return deps.json({ available: false, suggestions: [] })
    if (sessionId.length > 256 || assistantMessageId.length > 256 || lastUserText.length > 12_000 || lastAssistantText.length > 12_000) {
      return deps.json({ error: 'Suggestion input is too large' }, 413)
    }
    const owned = await deps.ownedSessionRecord(await deps.applicationDatabase(), authenticatedUser.id, sessionId)
    if (!owned) return deps.json({ error: 'Session not found' }, 404)
    const service = await deps.configuredSuggestionService()
    const suggestions = await service.get({ sessionId, assistantMessageId, lastUserText, lastAssistantText })
    return deps.json({ available: service.isAvailable(), suggestions })
  }
  if (path[0] === 'api' && path[1] === 'auth-info') {
    if (path[2] === 'config' && request.method === 'GET') {
      try { return deps.json(await deps.authConfig()) } catch (error) { console.warn(`Auth information unavailable: ${deps.redactedDiagnostic(error)}`); return deps.json({ message: 'PocketBase is unavailable' }, 503) }
    }
    if (path[2] === 'me' && request.method === 'GET') return deps.json({ user: await deps.authenticateRequest(request) })
  }
  return undefined
}
