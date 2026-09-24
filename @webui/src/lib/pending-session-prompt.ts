import type { PendingSessionPrompt } from '@/components/chat/ChatInputBar'

const STORAGE_PREFIX = 'subpolar:pending-session-prompt:'

export type PendingSessionPromptStatus = 'pending' | 'in-flight' | 'interrupted' | 'unknown'
export type StoredPendingSessionPrompt = PendingSessionPrompt & {
  status?: PendingSessionPromptStatus
}

function storageKey(sessionID: string): string {
  return `${STORAGE_PREFIX}${sessionID}`
}

export function savePendingSessionPrompt(sessionID: string, prompt: StoredPendingSessionPrompt): void {
  try {
    window.localStorage.setItem(storageKey(sessionID), JSON.stringify(prompt))
  } catch {
    // The in-memory route state remains the fallback when storage is unavailable.
  }
}

export function loadPendingSessionPrompt(sessionID: string): StoredPendingSessionPrompt | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(sessionID))
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<StoredPendingSessionPrompt>
    if (typeof value.prompt !== 'string' || typeof value.messageID !== 'string' || !value.messageID) return undefined
    return {
      prompt: value.prompt,
      messageID: value.messageID,
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
      ...(typeof value.agent === 'string' ? { agent: value.agent } : {}),
      ...(typeof value.permission === 'string' ? { permission: value.permission } : {}),
      ...(value.routing === true ? { routing: true } : {}),
       ...(value.status === 'pending' || value.status === 'in-flight' || value.status === 'interrupted' || value.status === 'unknown'
         ? { status: value.status }
         : {}),
    }
  } catch {
    return undefined
  }
}

export function clearPendingSessionPrompt(sessionID: string): void {
  try {
    window.localStorage.removeItem(storageKey(sessionID))
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
