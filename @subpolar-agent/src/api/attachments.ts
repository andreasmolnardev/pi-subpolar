import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export async function loadProjectAttachment(directory: string, path: string): Promise<{ path: string; name: string; size: number; mime: string }> {
  return fetchWrapper(`${API_BASE_URL}/api/attachments/project`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory, path }),
  })
}

export async function loadWebsiteAttachment(url: string): Promise<{ url: string; content: string; size: number }> {
  return fetchWrapper(`${API_BASE_URL}/api/attachments/website`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  })
}

export async function createProjectMarkdown(directory: string, name: string, content: string): Promise<{ path: string; name: string }> {
  return fetchWrapper(`${API_BASE_URL}/api/attachments/markdown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory, name, content }),
  })
}
