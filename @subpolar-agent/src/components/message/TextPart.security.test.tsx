import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TextPart } from './TextPart'
import type { components } from '@/api/opencode-types'

const mermaidMock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg><text>diagram</text></svg>' })) }))

vi.mock('mermaid', () => ({ default: mermaidMock }))

describe('TextPart security', () => {
  it('keeps raw HTML inert and configures Mermaid in strict mode', async () => {
    const part = { text: '<img src="x" onerror="alert(1)">\n\n```mermaid\ngraph TD\nA-->B\n```' } as components['schemas']['TextPart']
     const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
     const { container } = render(
       <QueryClientProvider client={queryClient}>
         <TextPart part={part} />
       </QueryClientProvider>,
     )
    expect(container.querySelector('img')).toBeNull()
    await waitFor(() => expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' })))
  })
})
