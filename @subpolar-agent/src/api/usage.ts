import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export type DailyUsage = {
  date: string
  input: number
  output: number
  cacheRead: number
}

export async function getDailyUsage(): Promise<{ days: DailyUsage[] }> {
  return fetchWrapper(`${API_BASE_URL}/api/usage/daily`)
}
