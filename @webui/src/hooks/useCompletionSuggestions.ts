import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

export interface CompletionSuggestionInput {
  sessionId: string
  assistantMessageId: string
  lastUserText: string
  lastAssistantText: string
}

export type CompletionSuggestionProvider = (input: CompletionSuggestionInput) => Promise<unknown> | unknown

export const unavailableCompletionSuggestionProvider: CompletionSuggestionProvider = async () => []

export function createApiCompletionSuggestionProvider(apiUrl = ''): CompletionSuggestionProvider {
  return async (input) => {
    const response = await fetch(`${apiUrl}/api/suggestions`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) return []
    const payload = await response.json() as { suggestions?: unknown }
    return payload.suggestions ?? []
  }
}

export const CompletionSuggestionContext = createContext<CompletionSuggestionProvider>(unavailableCompletionSuggestionProvider)

const normalize = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.reduce<string[]>((result, item) => {
    if (typeof item !== 'string') return result
    const text = item.replace(/\s+/g, ' ').trim()
    const key = text.toLocaleLowerCase()
    if (!text || text.length > 240 || seen.has(key) || result.length >= 3) return result
    seen.add(key)
    result.push(text)
    return result
  }, [])
}

export function useCompletionSuggestions(input: CompletionSuggestionInput | undefined): string[] {
  const provider = useContext(CompletionSuggestionContext)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const requestedId = useRef<string | undefined>(undefined)
  const key = input?.assistantMessageId

  useEffect(() => {
    if (!input || !input.lastUserText.trim() || !input.lastAssistantText.trim() || requestedId.current === key) return
    requestedId.current = key
    let active = true
    void Promise.resolve(provider({ ...input })).then((result) => {
      if (active) setSuggestions(normalize(result))
    }).catch(() => {
      if (active) setSuggestions([])
    })
    return () => { active = false }
  }, [input, key, provider])

  return useMemo(() => suggestions, [suggestions])
}
