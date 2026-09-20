export interface SuggestionInput {
  sessionId?: string
  assistantMessageId: string
  lastUserText: string
  lastAssistantText: string
}

export type SuggestionProvider = (input: SuggestionInput) => Promise<unknown> | unknown

export interface SuggestionService {
  get(input: SuggestionInput): Promise<string[]>
  isAvailable(): boolean
}

const normalizeSuggestions = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const suggestion = candidate.trim()
    if (!suggestion || suggestion.length > 240) continue
    const normalized = suggestion.replace(/\s+/g, ' ').trim()
    const key = normalized.toLocaleLowerCase()
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
    if (result.length === 3) break
  }
  return result
}

export function createSuggestionService(provider?: SuggestionProvider): SuggestionService {
  const completedAssistantIds = new Set<string>()

  return {
    isAvailable: () => Boolean(provider),
    async get(input) {
      if (!provider || !input.assistantMessageId || !input.lastUserText.trim() || !input.lastAssistantText.trim()) return []
      if (completedAssistantIds.has(input.assistantMessageId)) return []
      completedAssistantIds.add(input.assistantMessageId)

      try {
        return normalizeSuggestions(await provider({
          assistantMessageId: input.assistantMessageId,
          lastUserText: input.lastUserText,
          lastAssistantText: input.lastAssistantText,
        }))
      } catch {
        return []
      }
    },
  }
}

export { normalizeSuggestions }
