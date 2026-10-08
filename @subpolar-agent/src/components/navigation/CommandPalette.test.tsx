import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { CommandPalette } from './CommandPalette'

import { sessionWorkspaceApi as api } from '@/api/session-workspace'
import { WORKSPACE_OPEN_FILE } from '@/components/workspace/quickOpen'
import { getAuthGeneration, getAuthOwner } from '@/stores/authIdentityStore'

vi.mock('@/api/session-workspace', () => ({ sessionWorkspaceApi: { search: vi.fn() } }))
const navigate = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.search).mockResolvedValue({ paths: ['src/a.ts', 'src/b.ts'], truncated: false })
})
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => {
      const actualNavigate = actual.useNavigate()
      return (...args: Parameters<typeof actualNavigate>) => { navigate(...args); actualNavigate(...args) }
    } }
})

describe('CommandPalette', () => {
  it('filters actions and navigates with keyboard selection', () => {
    const onOpenChange = vi.fn()
    render(<MemoryRouter><CommandPalette open onOpenChange={onOpenChange} /></MemoryRouter>)
    const input = screen.getByRole('textbox', { name: 'Search commands' })
    fireEvent.change(input, { target: { value: 'project' } })
    expect(screen.getByRole('option', { name: /Switch project/ })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith('/projects')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('defaults to session files, debounces queries and dispatches a scoped open without navigation', async () => {
    const receive = vi.fn()
    window.addEventListener(WORKSPACE_OPEN_FILE, receive)
    try {
      vi.mocked(api.search).mockResolvedValue({ paths: ['src/a.ts', 'src/b.ts'], truncated: true })
      const close = vi.fn()
      render(<MemoryRouter initialEntries={['/projects/p/sessions/session%2Fid']}><CommandPalette open onOpenChange={close} /></MemoryRouter>)
      const input = screen.getByRole('textbox', { name: 'Search workspace files' })
      expect(screen.getByRole('status')).toHaveTextContent('Searching files')
      fireEvent.change(input, { target: { value: 'ab' } })
      fireEvent.change(input, { target: { value: 'ats' } })
      expect(api.search).not.toHaveBeenCalled()
      await screen.findByRole('option', { name: /b.ts/ })
      expect(api.search).toHaveBeenCalledTimes(1)
      expect(api.search).toHaveBeenCalledWith('session/id', 'ats', expect.any(AbortSignal))
      expect(screen.getByText(/Results limited to 100/)).toBeVisible()
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(close).toHaveBeenCalledWith(false)
      expect(navigate).not.toHaveBeenCalled()
      expect(receive.mock.calls[0][0].detail).toEqual({ sessionId: 'session/id', path: 'src/b.ts', requestId: expect.any(Number), owner: getAuthOwner(), generation: getAuthGeneration() })
    } finally { window.removeEventListener(WORKSPACE_OPEN_FILE, receive) }
  })

  it('switches to existing commands with > and cancels the file search', async () => {
    render(<MemoryRouter initialEntries={['/projects/p/sessions/s']}><CommandPalette open onOpenChange={vi.fn()} /></MemoryRouter>)
    await screen.findByRole('option', { name: /a.ts/ })
    const signal = vi.mocked(api.search).mock.calls[0][2]!
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '>project' } })
    expect(signal.aborted).toBe(true)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search commands' }), { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith('/projects')
  })

  it('ignores stale results after query and session route changes', async () => {
    const pending: Array<{ resolve: (value: { paths: string[]; truncated: boolean }) => void; signal?: AbortSignal }> = []
    vi.mocked(api.search).mockImplementation((_id, _query, signal) => new Promise(resolve => pending.push({ resolve, signal })))
    function RouteSwitch() {
      const go = useNavigate()
      return <button onClick={() => go('/projects/p/sessions/second')}>Change route</button>
    }
    render(<MemoryRouter initialEntries={['/projects/p/sessions/first']}><RouteSwitch /><CommandPalette open onOpenChange={vi.fn()} /></MemoryRouter>)
    await waitFor(() => expect(pending).toHaveLength(1))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new' } })
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[0].signal?.aborted).toBe(true)
    await act(async () => pending[0].resolve({ paths: ['stale-query.ts'], truncated: false }))
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change route' }))
    await waitFor(() => expect(api.search).toHaveBeenCalledWith('second', '', expect.any(AbortSignal)))
    expect(pending[1].signal?.aborted).toBe(true)
    await act(async () => {
      pending[1].resolve({ paths: ['stale-route.ts'], truncated: false })
      pending.at(-1)!.resolve({ paths: ['current.ts'], truncated: false })
    })
    expect(await screen.findByRole('option', { name: /current.ts/ })).toBeVisible()
    expect(screen.queryByText(/stale-/)).not.toBeInTheDocument()
  })

  it('shows failures and no matches, traps focus and closes on outside click or Escape', async () => {
    vi.mocked(api.search).mockRejectedValueOnce(new Error('Search unavailable'))
    const close = vi.fn()
    render(<MemoryRouter initialEntries={['/projects/p/sessions/s']}><button>Outside</button><CommandPalette open onOpenChange={close} /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Search unavailable')
    const input = screen.getByRole('textbox')
    screen.getByRole('button', { name: 'Outside' }).focus()
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(input).toHaveFocus()
    vi.mocked(api.search).mockResolvedValue({ paths: [], truncated: false })
    fireEvent.change(input, { target: { value: 'missing' } })
    expect(await screen.findByText('No matching files')).toBeVisible()
    fireEvent.click(screen.getByRole('dialog'))
    expect(close).toHaveBeenCalledWith(false)
    close.mockClear()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(close).toHaveBeenCalledWith(false)
  })

  it('restores focus on dismissal and cancels a pending search when closed', async () => {
    let signal: AbortSignal | undefined
    vi.mocked(api.search).mockImplementation((_id, _query, nextSignal) => {
      signal = nextSignal
      return new Promise(() => {})
    })
    function Palette() {
      const [open, setOpen] = useState(false)
      return <><textarea aria-label="Draft" /><button onClick={() => setOpen(true)}>Launch</button><CommandPalette open={open} onOpenChange={setOpen} /></>
    }
    render(<MemoryRouter initialEntries={['/projects/p/sessions/s']}><Palette /></MemoryRouter>)
    const draft = screen.getByLabelText('Draft')
    draft.focus()
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    await waitFor(() => expect(signal).toBeDefined())
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search workspace files' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(signal?.aborted).toBe(true)
    expect(draft).toHaveFocus()
  })

  it('moves selection with arrow keys', () => {
    render(<MemoryRouter><CommandPalette open onOpenChange={vi.fn()} /></MemoryRouter>)
    const input = screen.getByRole('textbox', { name: 'Search commands' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /Search sessions/ })).toHaveAttribute('aria-selected', 'true')
  })
})
