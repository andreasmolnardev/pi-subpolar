import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RepositoryContext } from './RepositoryContext'
import { ADD_PROVIDER_CONTEXT_EVENT } from './provider-context'
import { changeAuthOwner } from '@/stores/authIdentityStore'

const mocks = vi.hoisted(() => ({ sources: vi.fn(), status: vi.fn(), branches: vi.fn(), worktrees: vi.fn(), accounts: vi.fn(), repository: vi.fn(), providerBranches: vi.fn(), issues: vi.fn(), pulls: vi.fn(), comments: vi.fn(), statuses: vi.fn() }))
vi.mock('@/api/worktrees', () => ({ worktreesApi: { sources: mocks.sources } }))
vi.mock('@/api/git', async importOriginal => ({ ...await importOriginal<typeof import('@/api/git')>(), fetchRepositoryStatus: mocks.status, fetchRepositoryBranches: mocks.branches, fetchRepositoryWorktrees: mocks.worktrees }))
vi.mock('@/api/git-provider-accounts', () => ({ gitProviderAccountsApi: { list: mocks.accounts } }))
vi.mock('@/api/git-provider-data', () => ({ gitProviderDataApi: { repository: mocks.repository, branches: mocks.providerBranches, issues: mocks.issues, pulls: mocks.pulls, comments: mocks.comments, statuses: mocks.statuses } }))

const identity = { remote: 'origin', provider: 'github' as const, owner: 'octo', repo: 'demo' }
const mapping = { accountId: 'provider-account', owner: 'octo', repo: 'demo' }
function mount(session = 'session') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const view = render(<MemoryRouter><QueryClientProvider client={client}><RepositoryContext sessionId={session} projectRouteId="7" enabled /></QueryClientProvider></MemoryRouter>)
  return { ...view, client }
}
beforeEach(() => {
  vi.resetAllMocks()
  changeAuthOwner('repository-context-tests')
  mocks.sources.mockResolvedValue({ repositoryId: 'durable-id', repository: { head: 'local-head' }, branches: [], remotes: ['https://host/looks-like-something.git'] })
  mocks.status.mockResolvedValue({ repository: { head: 'local-head' }, status: { branch: 'main', ahead: 0, behind: 0, entries: [], omitted: [], truncated: false } })
  mocks.branches.mockResolvedValue({ branches: [] })
  mocks.worktrees.mockResolvedValue({ worktrees: [] })
  mocks.accounts.mockResolvedValue({ accounts: [{ id: mapping.accountId, provider: 'github', username: 'octo', displayName: 'Octo', avatarUrl: null, status: 'connected', capabilities: {}, connectedAt: 1 }] })
  mocks.repository.mockResolvedValue({ repository: { name: 'demo' } })
  mocks.providerBranches.mockResolvedValue({ branches: [{ name: 'main', sha: 'abc' }] })
  mocks.issues.mockResolvedValue({ issues: [{ number: 4, title: 'Bug title', state: 'open', body: 'Issue body' }] })
  mocks.pulls.mockResolvedValue({ pulls: [{ number: 8, title: 'Feature PR', state: 'open', base: 'main', head: 'feature', headSha: 'head-sha', body: 'PR body' }] })
  mocks.comments.mockResolvedValue({ comments: [{ user: { login: 'reviewer' }, body: 'Comment body' }] })
  mocks.statuses.mockResolvedValue({ statuses: [{ context: 'CI', state: 'success' }] })
})

describe('RepositoryContext provider browsing', () => {
  it('shows an explicit unavailable state and never guesses mapping from local remotes', async () => {
    const view = mount()
    expect(await screen.findByText(/no supported GitHub or Gitea remote identity/)).toBeInTheDocument()
    expect(mocks.accounts).not.toHaveBeenCalled()
    expect(mocks.issues).not.toHaveBeenCalled()
    view.unmount()
  })

  it('browses mapped issue and PR data read-only and caps issue listing', async () => {
    mocks.sources.mockResolvedValue({ repositoryId: 'durable-id', providerRepository: identity, repository: { head: 'local-head' }, branches: [], remotes: [] })
    mocks.issues.mockResolvedValue({ issues: Array.from({ length: 25 }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}`, state: 'open', body: 'issue body' })) })
    const view = mount()
    expect(await screen.findByRole('button', { name: /#1 Issue 1/ })).toBeInTheDocument()
    expect(mocks.issues).toHaveBeenCalledWith(mapping)
    expect(screen.queryByRole('button', { name: /#21 Issue 21/ })).not.toBeInTheDocument()
    const contextListener = vi.fn()
    window.addEventListener(ADD_PROVIDER_CONTEXT_EVENT, contextListener)
    fireEvent.click(screen.getAllByRole('button', { name: 'Add to context' })[0])
    expect(contextListener).toHaveBeenCalledWith(expect.objectContaining({ detail: { title: 'Issue #1: Issue 1', body: 'issue body' } }))
    window.removeEventListener(ADD_PROVIDER_CONTEXT_EVENT, contextListener)
    fireEvent.click(screen.getByRole('button', { name: /#1 Issue 1/ }))
    expect(await screen.findByText('Comment body')).toBeInTheDocument()
    mocks.comments.mockImplementation(async (_repository, number) => ({ comments: [{ user: { login: 'reviewer' }, body: number === 8 ? 'PR discussion comment' : 'Issue discussion comment' }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Pull requests' }))
    expect(await screen.findByText(/Feature PR/)).toBeInTheDocument()
    expect(await screen.findByText('CI: success')).toBeInTheDocument()
    expect(await screen.findByText('PR discussion comment')).toBeInTheDocument()
    expect(mocks.comments).toHaveBeenCalledWith(mapping, 8)
    expect(mocks.statuses).toHaveBeenCalledWith(mapping, 'head-sha')
    fireEvent.click(screen.getByRole('button', { name: 'Provider branches' }))
    expect(await screen.findByText('main · abc')).toBeInTheDocument()
    view.unmount()
  })

  it('auto-selects one matching account, requires a choice for multiple, and stays unavailable without one', async () => {
    mocks.sources.mockResolvedValue({ repositoryId: 'durable-id', providerRepository: identity, repository: { head: 'local-head' }, branches: [], remotes: [] })
    mocks.accounts.mockResolvedValue({ accounts: [
      { id: 'gitea-account', provider: 'gitea', username: 'team', displayName: 'Gitea team', status: 'connected' },
      { id: 'provider-account', provider: 'github', username: 'octo', displayName: 'Octo', status: 'connected' },
      { id: 'disabled-account', provider: 'github', username: 'old', displayName: 'Disabled', status: 'disabled' },
    ] })
    const single = mount('one-provider-account')
    expect(await screen.findByRole('button', { name: /#4 Bug title/ })).toBeInTheDocument()
    expect(mocks.issues).toHaveBeenCalledWith(mapping)
    single.unmount()

    mocks.accounts.mockResolvedValue({ accounts: [
      { id: 'provider-account', provider: 'github', username: 'octo', displayName: 'Octo', status: 'connected' },
      { id: 'second-account', provider: 'github', username: 'second', displayName: 'Second account', status: 'connected' },
    ] })
    mocks.issues.mockClear()
    const multiple = mount('multiple-provider-accounts')
    const selector = await screen.findByRole('combobox', { name: 'Provider account' })
    expect(mocks.issues).not.toHaveBeenCalled()
    fireEvent.change(selector, { target: { value: 'second-account' } })
    expect(await screen.findByRole('button', { name: /#4 Bug title/ })).toBeInTheDocument()
    expect(mocks.issues).toHaveBeenCalledWith({ ...mapping, accountId: 'second-account' })
    multiple.unmount()

    mocks.accounts.mockResolvedValue({ accounts: [{ id: 'gitea-account', provider: 'gitea', username: 'team', displayName: 'Gitea team', status: 'connected' }] })
    mocks.issues.mockClear()
    const none = mount('no-provider-account')
    expect(await screen.findByText(/no connected github account/)).toBeInTheDocument()
    expect(mocks.issues).not.toHaveBeenCalled()
    none.unmount()
  })

  it('shows empty results and provider request errors explicitly', async () => {
    mocks.sources.mockResolvedValue({ repositoryId: 'durable-id', providerRepository: identity, repository: { head: 'local-head' }, branches: [], remotes: [] })
    mocks.issues.mockResolvedValue({ issues: [] })
    const view = mount('empty')
    expect(await screen.findByText('No provider issues.')).toBeInTheDocument()
    view.unmount()

    mocks.issues.mockRejectedValue(new Error('Provider temporarily unavailable'))
    const failed = mount('provider-error')
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider temporarily unavailable')
    failed.unmount()
  })

  it('does not expose cached provider data after auth owner changes', async () => {
    mocks.sources.mockResolvedValue({ repositoryId: 'durable-id', providerRepository: identity, repository: { head: 'local-head' }, branches: [], remotes: [] })
    mocks.issues.mockResolvedValueOnce({ issues: [{ number: 1, title: 'Owner A issue', state: 'open' }] })
    const view = mount('shared')
    expect(await screen.findByRole('button', { name: /Owner A issue/ })).toBeInTheDocument()
    mocks.issues.mockResolvedValueOnce({ issues: [{ number: 2, title: 'Owner B issue', state: 'open' }] })
    act(() => changeAuthOwner('repository-context-owner-b'))
    expect(await screen.findByRole('button', { name: /Owner B issue/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Owner A issue/ })).not.toBeInTheDocument()
    await waitFor(() => expect(view.client.getQueryCache().getAll().some(query => query.queryKey[0] === 'provider-repository' && query.queryKey[1] === 'repository-context-tests')).toBe(false))
    view.unmount()
    act(() => changeAuthOwner(null))
  })
})
