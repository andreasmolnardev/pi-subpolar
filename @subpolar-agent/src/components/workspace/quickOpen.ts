import { getAuthGeneration, getAuthOwner } from '@/stores/authIdentityStore'

export const WORKSPACE_OPEN_FILE = 'subpolar:workspace-open-file'
export const WORKSPACE_QUICK_OPEN = 'subpolar:workspace-quick-open'

export interface FileOpenRequest { path: string; requestId: number }
export interface WorkspaceOpenFileDetail extends FileOpenRequest { sessionId: string; owner?: string | null; generation?: number }
let requestId = 0

export function sessionIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/[^/]+\/sessions\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}

export function requestWorkspaceFile(sessionId: string, path: string) {
  window.dispatchEvent(new CustomEvent<WorkspaceOpenFileDetail>(WORKSPACE_OPEN_FILE, {
    detail: { sessionId, path, requestId: ++requestId, owner: getAuthOwner(), generation: getAuthGeneration() },
  }))
}

export function requestQuickOpen(sessionId: string) {
  window.dispatchEvent(new CustomEvent<{ sessionId: string }>(WORKSPACE_QUICK_OPEN, { detail: { sessionId } }))
}

export function isWorkspaceOpenFileDetail(value: unknown): value is WorkspaceOpenFileDetail {
  if (!value || typeof value !== 'object') return false
  const detail = value as Partial<WorkspaceOpenFileDetail>
  // This event is only UI intent, never an authorization capability. The server owns access.
  if ('owner' in detail && detail.owner !== getAuthOwner()) return false
  if ('generation' in detail && detail.generation !== getAuthGeneration()) return false
  return typeof detail.sessionId === 'string' && typeof detail.path === 'string' && detail.path.length > 0 &&
    typeof detail.requestId === 'number' && Number.isSafeInteger(detail.requestId)
}
