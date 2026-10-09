import type { UserPreferences } from '@/api/types/settings'
import { DEFAULT_USER_PREFERENCES } from '@/api/types/settings'

type AgentVisibilityPreferences = Pick<UserPreferences, 'hiddenAgents' | 'hiddenSidebarAgents' | 'hiddenChatInputAgents'>

/**
 * Use the shared list when present. Older saved preferences had separate
 * sidebar and chat lists, so merge them once into a single effective list.
 */
export function getHiddenAgents(preferences?: Partial<AgentVisibilityPreferences> | null): string[] {
  if (Array.isArray(preferences?.hiddenAgents)) return preferences.hiddenAgents

  const legacyLists = [
    preferences?.hiddenSidebarAgents ?? DEFAULT_USER_PREFERENCES.hiddenSidebarAgents,
    preferences?.hiddenChatInputAgents ?? DEFAULT_USER_PREFERENCES.hiddenChatInputAgents,
  ]
  const uniqueNames = new Map<string, string>()
  for (const name of legacyLists.flat()) uniqueNames.set(name.toLowerCase(), name)
  return [...uniqueNames.values()]
}
