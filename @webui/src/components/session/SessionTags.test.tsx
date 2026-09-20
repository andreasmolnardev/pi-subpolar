import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionTags } from './SessionTags'
import type { StoredSession } from '@/api/sessions'

const { updateStoredSessionMock } = vi.hoisted(() => ({ updateStoredSessionMock: vi.fn() }))

vi.mock('@/api/sessions', async () => {
  const actual = await vi.importActual<typeof import('@/api/sessions')>('@/api/sessions')
  return { ...actual, updateStoredSession: updateStoredSessionMock }
})

const session = (tags: string[] = ['bug', 'urgent']): StoredSession => ({
  id: 'session-1',
  projectId: null,
  directory: '/work',
  title: 'A session',
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  tags,
})

function renderTags(tags?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionTags session={session(tags)} />
    </QueryClientProvider>,
  )
}

describe('SessionTags', () => {
  beforeEach(() => {
    updateStoredSessionMock.mockReset()
    updateStoredSessionMock.mockResolvedValue(undefined)
  })

  it('renders accessible badges and removes a tag', async () => {
    const user = userEvent.setup()
    renderTags()

    expect(screen.getByText('bug')).toBeInTheDocument()
    expect(screen.getByText('urgent')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove tag bug' }))

    await waitFor(() => expect(updateStoredSessionMock).toHaveBeenCalledWith('session-1', { tags: ['urgent'] }))
  })

  it('adds a tag and rejects duplicates and invalid values', async () => {
    const user = userEvent.setup()
    renderTags()
    const input = screen.getByRole('textbox', { name: 'New session tag' })

    await user.type(input, 'bug')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('alert')).toHaveTextContent('already added')
    expect(updateStoredSessionMock).not.toHaveBeenCalled()

    await user.clear(input)
    await user.type(input, 'bad,tag')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Use letters')
    expect(updateStoredSessionMock).not.toHaveBeenCalled()

    await user.clear(input)
    await user.type(input, 'frontend')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(updateStoredSessionMock).toHaveBeenCalledWith('session-1', { tags: ['bug', 'urgent', 'frontend'] }))
  })

  it('shows loading and error states without changing the displayed tags optimistically', async () => {
    const user = userEvent.setup()
    let rejectMutation!: (error: Error) => void
    updateStoredSessionMock.mockReturnValueOnce(new Promise<void>((_, reject) => { rejectMutation = reject }))
    renderTags([])

    await user.type(screen.getByRole('textbox', { name: 'New session tag' }), 'work')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    expect(screen.queryByText('work')).not.toBeInTheDocument()

    rejectMutation(new Error('network failure'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save tags'))
  })
})
