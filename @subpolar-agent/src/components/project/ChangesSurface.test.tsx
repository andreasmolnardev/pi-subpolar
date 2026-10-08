import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChangesSurface } from './ChangesSurface'

const mocks = vi.hoisted(() => ({
  fetchRepositoryStatus: vi.fn(),
  fetchRepositoryDiff: vi.fn(),
}))

vi.mock('@/api/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/git')>()),
  fetchRepositoryStatus: mocks.fetchRepositoryStatus,
  fetchRepositoryDiff: mocks.fetchRepositoryDiff,
}))

function renderSurface() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><ChangesSurface projectId="7" /></QueryClientProvider>)
}

describe('ChangesSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchRepositoryStatus.mockResolvedValue({
      repository: { root: '.', gitDir: '.git', bare: false, head: 'abc' },
      status: {
        branch: 'feature/review', ahead: 2, behind: 1, truncated: true,
        omitted: [{ path: 'secret.env', reason: 'PATH_DENIED' }],
        entries: [
          { path: 'src/app.ts', index: 'M', worktree: ' ', untracked: false, renamed: false },
          { path: 'new.txt', index: '?', worktree: '?', untracked: true, renamed: false },
        ],
      },
    })
    mocks.fetchRepositoryDiff.mockResolvedValue({
      repository: { root: '.', gitDir: '.git', bare: false, head: 'abc' },
      diff: { path: 'src/app.ts', text: '+new line', truncated: false, binary: false, bytes: 9 },
    })
  })

  it('shows repository metadata, file states, omissions, and a selected bounded diff', async () => {
    renderSurface()

    expect(await screen.findByText('feature/review')).toBeInTheDocument()
    expect(screen.getByText('2 ahead')).toBeInTheDocument()
    expect(screen.getByText('1 behind')).toBeInTheDocument()
    expect(screen.getByText('Some repository entries were truncated by the server.')).toBeInTheDocument()
    expect(screen.getByText(/path omitted because access was denied/)).toBeInTheDocument()
    expect(screen.getAllByText('Staged').length).toBeGreaterThan(0)
    expect(screen.getByText('Untracked')).toBeInTheDocument()
    expect(await screen.findByText('+new line')).toBeInTheDocument()
    expect(mocks.fetchRepositoryDiff).toHaveBeenCalledWith('7', { path: 'src/app.ts', staged: true })
  })

  it('renders binary diffs and retries a failed status request', async () => {
    mocks.fetchRepositoryStatus.mockRejectedValueOnce(new Error('Permission denied'))
    renderSurface()
    expect(await screen.findByText('Permission denied. Check your repository access.')).toBeInTheDocument()

    mocks.fetchRepositoryStatus.mockResolvedValueOnce({
      repository: { root: '.', gitDir: '.git', bare: false, head: null },
      status: { branch: null, ahead: 0, behind: 0, truncated: false, omitted: [], entries: [{ path: 'image.png', index: ' ', worktree: 'M', untracked: false, renamed: false }] },
    })
    mocks.fetchRepositoryDiff.mockResolvedValueOnce({
      repository: { root: '.', gitDir: '.git', bare: false, head: null },
      diff: { path: 'image.png', text: '', truncated: false, binary: true, bytes: 0 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Binary file; no text diff is available.')).toBeInTheDocument()
    await waitFor(() => expect(mocks.fetchRepositoryStatus).toHaveBeenCalledTimes(2))
  })
})
