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
        const pushSubscription = input.subscription && typeof input.subscription === 'object' ? input.subscription as Record<string, unknown> : undefined
        const target = input.channel === 'push' ? pushSubscription?.endpoint : input.target
        const keys = pushSubscription?.keys && typeof pushSubscription.keys === 'object' ? pushSubscription.keys as Record<string, unknown> : undefined
        if ((input.channel !== 'push' && input.channel !== 'email') || typeof target !== 'string') return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'channel and target are required', 400)
        if (input.channel === 'push' && (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string')) return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'A complete browser push subscription is required', 400)
        return deps.json({ subscription: await notifications.subscribe(authenticatedUser.id, { channel: input.channel, target, ...(keys ? { keys: keys as { p256dh: string; auth: string } } : {}), ...(typeof input.deviceName === 'string' ? { deviceName: input.deviceName } : {}) }) }, 201, correlationId)
      }
      if (path.length === 3 && path[2] === 'subscribe' && (request.method === 'POST' || request.method === 'DELETE')) {
        const input = await deps.body(request)
        if (typeof input.endpoint !== 'string' || !input.endpoint.trim()) return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'endpoint is required', 400)
        if (request.method === 'DELETE') {
          if (!await notifications.removeByEndpoint(authenticatedUser.id, input.endpoint)) return deps.routeError(correlationId, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND', 'Notification subscription not found', 404)
          return deps.json({ success: true }, 200, correlationId)
        }
        if (!input.subscription || typeof input.subscription !== 'object') return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'A complete browser push subscription is required', 400)
        const subscription = input.subscription as Record<string, unknown>
        const keys = subscription.keys && typeof subscription.keys === 'object' ? subscription.keys as Record<string, unknown> : undefined
        if (typeof subscription.endpoint !== 'string' || typeof keys?.p256dh !== 'string' || typeof keys.auth !== 'string') return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'A complete browser push subscription is required', 400)
        return deps.json({ subscription: await notifications.subscribe(authenticatedUser.id, { channel: 'push', target: subscription.endpoint, keys: keys as { p256dh: string; auth: string }, ...(typeof input.deviceName === 'string' ? { deviceName: input.deviceName } : {}) }) }, 201, correlationId)
      }
      if (path.length === 3 && path[2] === 'subscriptions' && request.method === 'GET') return deps.json({ subscriptions: await notifications.list(authenticatedUser.id) }, 200, correlationId)
      if (path.length === 3 && path[2] === 'subscriptions' && request.method === 'POST') {
        const input = await deps.body(request)
        const pushSubscription = input.subscription && typeof input.subscription === 'object' ? input.subscription as Record<string, unknown> : undefined
        const target = input.channel === 'push' ? pushSubscription?.endpoint : input.target
        const keys = pushSubscription?.keys && typeof pushSubscription.keys === 'object' ? pushSubscription.keys as Record<string, unknown> : undefined
        if ((input.channel !== 'push' && input.channel !== 'email') || typeof target !== 'string') return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'channel and target are required', 400)
        if (input.channel === 'push' && (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string')) return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'A complete browser push subscription is required', 400)
        return deps.json({ subscription: await notifications.subscribe(authenticatedUser.id, { channel: input.channel, target, ...(keys ? { keys: keys as { p256dh: string; auth: string } } : {}), ...(typeof input.deviceName === 'string' ? { deviceName: input.deviceName } : {}) }) }, 201, correlationId)
      }
      if (path.length === 4 && path[2] === 'subscriptions' && request.method === 'DELETE') {
        if (!await notifications.remove(authenticatedUser.id, decodeURIComponent(path[3]))) return deps.routeError(correlationId, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND', 'Notification subscription not found', 404)
        return deps.json({ success: true }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'subscriptions' && request.method === 'DELETE') {
        const input = await deps.body(request)
        if (typeof input.endpoint !== 'string' || !input.endpoint.trim()) return deps.routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'endpoint is required', 400)
        if (!await notifications.removeByEndpoint(authenticatedUser.id, input.endpoint)) return deps.routeError(correlationId, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND', 'Notification subscription not found', 404)
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
        const saved = await deps.saveUserPreferences(client, authenticatedUser.id, { ...current, notifications: deps.notificationPreferenceValue({ ...deps.object(current.notifications), ...requested, events: { ...deps.object(deps.object(current.notifications).events), ...deps.object(requested.events) } }) })
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
        const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
        return publicKey && privateKey ? deps.json({ publicKey }, 200, correlationId) : deps.routeError(correlationId, 'NOTIFICATION_PUSH_UNAVAILABLE', 'Push notifications are not configured', 503)
      }
      if (path.length === 3 && path[2] === 'test' && request.method === 'POST') {
        const record = await deps.getUserPreferences(client, authenticatedUser.id)
        const preferences = deps.notificationPreferenceValue(record?.preferences && deps.object(record.preferences).notifications)
        if (preferences.enabled !== true) return deps.routeError(correlationId, 'NOTIFICATIONS_DISABLED', 'Enable push notifications before sending a test', 409)
        const subscriptions = (await notifications.list(authenticatedUser.id)).filter((item) => item.channel === 'push' && item.enabled)
        if (!subscriptions.length) return deps.routeError(correlationId, 'NOTIFICATION_NO_SUBSCRIPTIONS', 'Register a device before sending a test', 409)
        const inbox = new deps.InboxRepository(client)
        const item = await inbox.upsert({
          owner_id: authenticatedUser.id,
          kind: 'automation_result',
          reference_id: `notification-test-${crypto.randomUUID()}`,
          title: 'Subpolar notification test',
          body: 'Push notifications are connected on this device.',
          deep_link: { path: '/settings' },
          underlying_state: 'test',
        })
        const devicesNotified = await notifications.deliver(authenticatedUser.id, item, undefined, { force: true })
        await inbox.resolve(authenticatedUser.id, item.id)
        if (!devicesNotified) return deps.routeError(correlationId, 'NOTIFICATION_TEST_FAILED', 'No registered device accepted the test notification', 502)
        return deps.json({ success: true, devicesNotified }, 200, correlationId)
      }
    } catch (error) {
      return deps.routeError(correlationId, 'NOTIFICATION_REQUEST_FAILED', error instanceof Error ? error.message : 'Notification request failed', 400)
    }
  }
  return undefined
}
