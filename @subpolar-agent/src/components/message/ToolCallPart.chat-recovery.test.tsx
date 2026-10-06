import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { components } from '@/api/opencode-types'
import { ToolCallPart } from './ToolCallPart'

vi.mock('@/hooks/useSettings', () => ({ useSettings: () => ({ preferences: { expandToolCalls: false } }) }))
vi.mock('@/contexts/EventContext', () => ({
  usePermissions: () => ({ getForCallID: () => null }),
  useQuestions: () => ({ getForCallID: () => null }),
}))

afterEach(() => vi.unstubAllGlobals())

function part(url: string): components['schemas']['ToolPart'] {
  return {
    id: 'tool', messageID: 'message', sessionID: 'session', callID: 'call', type: 'tool', tool: 'bash',
    state: { status: 'completed', input: { command: 'echo hello' }, output: 'Output stored separately', title: 'bash', metadata: { detailsUrl: url }, time: { start: 1, end: 2 } },
  }
}

function expand(container: HTMLElement) {
  const details = container.querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
}

describe('history tool details recovery', () => {
  it('loads durable tool output only after the timeline row is opened', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ output: 'Recovered output' }))
    vi.stubGlobal('fetch', fetch)
    const { container } = render(<ToolCallPart part={part('/details/one')} />)
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByText('Loading details...')).not.toBeInTheDocument()
    expand(container)
    expect(await screen.findByText('Recovered output')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/details/one')
  })

  it('shows a retryable load failure instead of a permanent loading label', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json({ output: 'Recovered after retry' }))
    vi.stubGlobal('fetch', fetch)
    const { container } = render(<ToolCallPart part={part('/details/one')} />)
    expand(container)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry loading details' }))
    expect(await screen.findByText('Recovered after retry')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Loading details...')).not.toBeInTheDocument()
  })

  it('does not reuse details when a replay replaces the details URL', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ output: 'Old output' })).mockResolvedValueOnce(Response.json({ output: 'New output' }))
    vi.stubGlobal('fetch', fetch)
    const { container, rerender } = render(<ToolCallPart part={part('/details/one')} />)
    expand(container)
    await screen.findByText('Old output')
    rerender(<ToolCallPart part={part('/details/two')} />)
    expect(screen.queryByText('Old output')).not.toBeInTheDocument()
    await screen.findByText('New output')
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })
})
