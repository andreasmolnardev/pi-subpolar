import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { CompletionSuggestionContext, createApiCompletionSuggestionProvider, useCompletionSuggestions, type CompletionSuggestionInput } from './hooks/useCompletionSuggestions'

describe('production suggestion wiring', () => {
  it('supports the provider injected by the production tree and suggestion actions', async () => {
    const provider = vi.fn<(_: CompletionSuggestionInput) => Promise<unknown>>().mockResolvedValue(['Follow up'])
    const input = { assistantMessageId: 'assistant-1', lastUserText: 'user', lastAssistantText: 'answer' }
    const { result } = renderHook(() => useCompletionSuggestions(input), {
      wrapper: ({ children }) => (
        <CompletionSuggestionContext.Provider value={provider}>
          {children}
        </CompletionSuggestionContext.Provider>
      ),
    })

    await act(async () => {})

    expect(provider).toHaveBeenCalledWith(input)
    expect(result.current).toEqual(['Follow up'])
  })

  it('uses the configured API provider and falls back when unavailable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ available: true, suggestions: ['Ask next'] }), { status: 200 }))
    const provider = createApiCompletionSuggestionProvider()
    await expect(provider({ sessionId: 'session-1', assistantMessageId: 'assistant-1', lastUserText: 'user', lastAssistantText: 'answer' })).resolves.toEqual(['Ask next'])
    expect(fetchMock).toHaveBeenCalledWith('/api/suggestions', expect.objectContaining({ credentials: 'include' }))

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ available: false, suggestions: [] }), { status: 200 }))
    await expect(provider({ sessionId: 'session-1', assistantMessageId: 'assistant-2', lastUserText: 'user', lastAssistantText: 'answer' })).resolves.toEqual([])
    fetchMock.mockRestore()
  })
})
