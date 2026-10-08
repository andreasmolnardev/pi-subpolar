import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notificationsApi } from './notifications'

describe('notification API routes', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ subscriptions: [], preferences: {}, deliveries: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))))
  })

  afterEach(() => vi.restoreAllMocks())

  it('never sends a caller-selected owner identity', async () => {
    await notificationsApi.subscribe({ endpoint: 'https://push.example.test/sub', keys: { p256dh: 'key', auth: 'auth' } })
    await notificationsApi.getSubscriptions()
    await notificationsApi.getPreferences()
    await notificationsApi.getDeliveryStatus(10)

    for (const [url, options] of (fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit | undefined]>) {
      expect(url).not.toContain('userId=')
      expect(url).not.toContain('ownerId=')
      if (options?.body) expect(String(options.body)).not.toContain('userId')
    }
  })

  it('uses separate subscription and delivery-status resources', async () => {
    await notificationsApi.removeSubscription('subscription-1')
    await notificationsApi.getDeliveryStatus(5)

    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(new URL(calls[0][0]).pathname).toBe('/api/notifications/subscriptions/subscription-1')
    expect(new URL(calls[1][0]).pathname + new URL(calls[1][0]).search).toBe('/api/notifications/delivery-status?limit=5')
  })
})
