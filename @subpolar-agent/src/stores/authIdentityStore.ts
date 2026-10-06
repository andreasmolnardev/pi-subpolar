import { useSyncExternalStore } from 'react'
import { useSendErrorStore } from './sendErrorStore'
import { resetSessionStatus } from './sessionStatusStore'
import { useSessionTodos } from './sessionTodosStore'
import { useUIState } from './uiStateStore'
import { useUserBash } from './userBashStore'
import { useSessionAgentStore } from './sessionAgentStore'

let owner: string | null = null
let generation = 0
const listeners = new Set<() => void>()
const cleanups = new Set<() => void>()

export const getAuthOwner = () => owner
export const getAuthGeneration = () => generation
export function onIdentityCleanup(cleanup: () => void) {
  cleanups.add(cleanup)
  return () => { cleanups.delete(cleanup) }
}
export function subscribeIdentity(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function useAuthOwner() {
  return useSyncExternalStore(subscribeIdentity, getAuthOwner, getAuthOwner)
}
export function useAuthGeneration() {
  return useSyncExternalStore(subscribeIdentity, getAuthGeneration, getAuthGeneration)
}

// Run before publishing auth changes so no new owner can observe the previous cache.
export function changeAuthOwner(next: string | null) {
  if (owner === next) return
  owner = next
  generation++
  for (const cleanup of cleanups) cleanup()
  // The legacy prompt handoff is session-keyed localStorage. Remove only that
  // sensitive namespace on identity changes, never arbitrary config/secrets.
  try {
    const storage = window.localStorage
    const previousOwner = storage.getItem('subpolar:auth-owner')
    // Retain same-owner recovery handoffs across page reloads. Legacy handoffs
    // without an owner marker cannot be safely attributed to the next login.
    if (previousOwner !== next) {
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      for (const key of keys) {
        if (key?.startsWith('subpolar:pending-session-prompt:')) storage.removeItem(key)
      }
    }
    if (next) storage.setItem('subpolar:auth-owner', next)
    else storage.removeItem('subpolar:auth-owner')
  } catch { /* Storage may be disabled. */ }
  resetSessionStatus()
  useSendErrorStore.setState({ errors: {}, queuedPrompts: {} })
  useSessionTodos.setState({ todos: new Map() })
  useUserBash.setState({ userBashCommands: new Map() })
  useUIState.setState({ isEditingMessage: false, activePromptFileBasePath: null, pendingPromptCommand: null, pendingPromptFile: null })
  // Only session-specific metadata; do not clear provider secrets or user preferences.
  useSessionAgentStore.setState({ agents: {} })
  for (const listener of listeners) listener()
}

export function assertAuthGeneration(expected: number) {
  if (generation !== expected) throw new DOMException('Account changed', 'AbortError')
}
