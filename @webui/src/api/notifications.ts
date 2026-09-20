import type { PushSubscriptionRecord, NotificationPreferences } from '@subpolar/shared/types'
import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export interface NotificationDeliveryStatus {
  id: string
  inbox_id: string
  subscription_id: string
  state: 'delivered' | 'failed'
  error_message?: string
  created_at: number
}

export const notificationsApi = {
  getVapidPublicKey: async (): Promise<{ publicKey: string }> => {
    return fetchWrapper(`${API_BASE_URL}/api/notifications/vapid-public-key`)
  },

  subscribe: async (
    subscription: PushSubscriptionJSON,
    deviceName?: string,
  ): Promise<{ subscription: PushSubscriptionRecord }> => {
    return fetchWrapper(`${API_BASE_URL}/api/notifications/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'push',
        target: subscription.endpoint,
        deviceName,
      }),
    })
  },

  unsubscribe: async (endpoint: string): Promise<{ success: boolean }> => {
    return fetchWrapper(`${API_BASE_URL}/api/notifications/subscriptions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
  },

  getSubscriptions: async (): Promise<{
    subscriptions: PushSubscriptionRecord[]
  }> => {
    return fetchWrapper(`${API_BASE_URL}/api/notifications/subscriptions`)
  },

  removeSubscription: async (
    id: string | number,
  ): Promise<{ success: boolean }> => {
    return fetchWrapper(`${API_BASE_URL}/api/notifications/subscriptions/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
    })
  },

  getPreferences: async (): Promise<{ preferences: NotificationPreferences; updatedAt: number }> => {
    return fetchWrapper(`${API_BASE_URL}/api/notifications/preferences`)
  },

  updatePreferences: async (preferences: Partial<NotificationPreferences>): Promise<{ preferences: NotificationPreferences; updatedAt: number }> => {
    return fetchWrapper(`${API_BASE_URL}/api/notifications/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences }),
    })
  },

  getDeliveryStatus: async (limit?: number): Promise<{ deliveries: NotificationDeliveryStatus[] }> => {
    return fetchWrapper(`${API_BASE_URL}/api/notifications/delivery-status`, {
      params: { limit },
    })
  },

  sendTest: async (): Promise<{
    success: boolean
    devicesNotified: number
  }> => {
    return fetchWrapper(`${API_BASE_URL}/api/notifications/test`, {
      method: 'POST',
    })
  },
}
