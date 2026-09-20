import { describe, expect, it, vi } from 'vitest'
import { createSuggestionService, normalizeSuggestions } from './suggestions'

describe('suggestions', () => {
  it('passes only the last visible user and assistant text', async () => {
    const provider = vi.fn().mockResolvedValue([])
    const service = createSuggestionService(provider)

    await service.get({ assistantMessageId: 'assistant-1', lastUserText: 'user text', lastAssistantText: 'assistant text' })

    expect(provider).toHaveBeenCalledWith({
      assistantMessageId: 'assistant-1',
      lastUserText: 'user text',
      lastAssistantText: 'assistant text',
    })
  })

  it('bounds and deduplicates schema-valid suggestions', () => {
    expect(normalizeSuggestions([' One ', 'one', 'Two\nwords', '', 4, 'three', 'four'])).toEqual([
      'One', 'Two words', 'three',
    ])
  })

  it('falls back when disabled or the provider fails', async () => {
    expect(await createSuggestionService().get({ assistantMessageId: 'a', lastUserText: 'u', lastAssistantText: 'a' })).toEqual([])
    expect(await createSuggestionService(vi.fn().mockRejectedValue(new Error('offline'))).get({ assistantMessageId: 'a', lastUserText: 'u', lastAssistantText: 'a' })).toEqual([])
  })

  it('reports whether a provider is configured', () => {
    expect(createSuggestionService().isAvailable()).toBe(false)
    expect(createSuggestionService(() => []).isAvailable()).toBe(true)
  })

  it('calls a provider once per assistant message', async () => {
    const provider = vi.fn().mockResolvedValue(['Continue'])
    const service = createSuggestionService(provider)
    const input = { assistantMessageId: 'assistant-1', lastUserText: 'u', lastAssistantText: 'a' }

    await service.get(input)
    await service.get(input)

    expect(provider).toHaveBeenCalledTimes(1)
  })
})
