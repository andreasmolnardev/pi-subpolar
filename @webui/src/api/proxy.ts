import { API_BASE_URL } from '@/config'
import { fetchWrapper, fetchWrapperVoid } from './fetchWrapper'

export type ProxyCredential = {
  id: string
  prefix: string
  createdAt: number
  lastUsedAt: number | null
}

export type GeneratedProxyCredential = {
  credential: ProxyCredential
  secret: string
}

export async function listProxyCredentials(): Promise<{ credentials: ProxyCredential[] }> {
  return fetchWrapper(`${API_BASE_URL}/api/proxy/credentials`)
}

export async function generateProxyCredential(): Promise<GeneratedProxyCredential> {
  return fetchWrapper(`${API_BASE_URL}/api/proxy/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function revokeProxyCredential(id: string): Promise<void> {
  return fetchWrapperVoid(`${API_BASE_URL}/api/proxy/credentials/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function proxyBaseUrl(): string {
  return `${window.location.origin}/proxy/v1`
}
