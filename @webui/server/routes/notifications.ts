/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleNotificationsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'notifications' && authenticatedUser) {
    try {
      const client = await deps.applicationDatabase()
      const notifications = new deps.NotificationRepository(client)
      if (path.length === 2 && request.method === 'GET') return deps.json({ subscriptions: await notifications.list(authenticatedUser.id) }, 200, correlationId)
      if (path.length === 2 && request.method === 'POST') {
        const input = await deps.body(request)
        if ((input.channel !== 'push' && input.channel !== 'email') || typeof input.target !== 'string') return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'channel and target are required', 400)
        return deps.json({ subscription: await notifications.subscribe(authenticatedUser.id, { channel: input.channel, target: input.target }) }, 201, correlationId)
      }
      if (path.length === 3 && path[2] === 'subscribe' && (request.method === 'POST' || request.method === 'DELETE')) {
        const input = await deps.body(request)
        if (typeof input.endpoint !== 'string' || !input.endpoint.trim()) return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'endpoint is required', 400)
        const rows = await client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${deps.escapeFilter(authenticatedUser.id)}"` }) as Array<Record<string, unknown>>
        const existing = rows.find((item) => item.owner_id === authenticatedUser.id && item.target === input.endpoint)
        if (request.method === 'DELETE') {
          if (!existing) return deps.routeError(correlationId, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND', 'Notification subscription not found', 404)
          await client.collection('notification_subscriptions').delete(String(existing.id))
          return deps.json({ success: true }, 200, correlationId)
        }
        if (existing) return deps.json({ subscription: existing }, 200, correlationId)
        return deps.json({ subscription: await notifications.subscribe(authenticatedUser.id, { channel: 'push', target: input.endpoint }) }, 201, correlationId)
      }
      if (path.length === 3 && path[2] === 'subscriptions' && request.method === 'GET') return deps.json({ subscriptions: await notifications.list(authenticatedUser.id) }, 200, correlationId)
      if (path.length === 3 && path[2] === 'subscriptions' && request.method === 'POST') {
        const input = await deps.body(request)
        if ((input.channel !== 'push' && input.channel !== 'email') || typeof input.target !== 'string') return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'channel and target are required', 400)
        return deps.json({ subscription: await notifications.subscribe(authenticatedUser.id, { channel: input.channel, target: input.target }) }, 201, correlationId)
      }
      if (path.length === 4 && path[2] === 'subscriptions' && request.method === 'DELETE') {
        const subscription = await client.collection('notification_subscriptions').getOne(decodeURIComponent(path[3])).catch(() => null) as Record<string, unknown> | null
        if (!subscription || subscription.owner_id !== authenticatedUser.id) return deps.routeError(correlationId, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND', 'Notification subscription not found', 404)
        await client.collection('notification_subscriptions').delete(String(subscription.id))
        return deps.json({ success: true }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'subscriptions' && request.method === 'DELETE') {
        const input = await deps.body(request)
        if (typeof input.endpoint !== 'string' || !input.endpoint.trim()) return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'endpoint is required', 400)
        const rows = await client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${deps.escapeFilter(authenticatedUser.id)}"` }) as Array<Record<string, unknown>>
        const subscription = rows.find((item) => item.owner_id === authenticatedUser.id && item.target === input.endpoint)
        if (!subscription) return deps.routeError(correlationId, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND', 'Notification subscription not found', 404)
        await client.collection('notification_subscriptions').delete(String(subscription.id))
        return deps.json({ success: true }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'preferences' && request.method === 'GET') {
        const record = await deps.getUserPreferences(client, authenticatedUser.id)
        return deps.json({ preferences: deps.notificationPreferenceValue(record?.preferences && deps.object(record.preferences).notifications), updatedAt: record?.updated_at ?? Date.now() }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'preferences' && request.method === 'PATCH') {
        const input = await deps.body(request)
        const record = await deps.getUserPreferences(client, authenticatedUser.id)
        const current = deps.object(record?.preferences)
        const requested = deps.object(input.preferences ?? input)
        const saved = await deps.saveUserPreferences(client, authenticatedUser.id, { ...current, notifications: deps.notificationPreferenceValue({ ...object(current.notifications), ...requested, events: { ...object(deps.object(current.notifications).events), ...object(requested.events) } }) })
        return deps.json({ preferences: deps.notificationPreferenceValue(deps.object(saved.preferences).notifications), updatedAt: saved.updated_at ?? Date.now() }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'delivery-status' && request.method === 'GET') {
        const limit = deps.routeLimit(url.searchParams.get('limit'))
        const rows = (await client.collection('notification_deliveries').getList(1, limit, { filter: `owner_id = "${deps.escapeFilter(authenticatedUser.id)}"`, sort: '-created_at' })).items as Array<Record<string, unknown>>
        const deliveries = rows.filter((item) => item.owner_id === authenticatedUser.id).slice(0, limit).map((item) => ({ id: item.id, inbox_id: item.inbox_id, subscription_id: item.subscription_id, state: item.state, error_message: item.error_message, created_at: item.created_at }))
        return deps.json({ deliveries }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'vapid-public-key' && request.method === 'GET') {
        const publicKey = process.env.VAPID_PUBLIC_KEY?.trim()
        return publicKey ? deps.json({ publicKey }, 200, correlationId) : deps.routeError(correlationId, 'NOTIFICATION_PUSH_UNAVAILABLE', 'Push notifications are not configured', 503)
      }
      if (path.length === 3 && path[2] === 'test' && request.method === 'POST') return deps.routeError(correlationId, 'NOTIFICATION_TEST_UNAVAILABLE', 'Notification test delivery is not configured', 501)
    } catch (error) {
      return deps.routeError(correlationId, 'NOTIFICATION_REQUEST_FAILED', error instanceof Error ? error.message : 'Notification request failed', 400)
    }
  }
  return undefined
}
