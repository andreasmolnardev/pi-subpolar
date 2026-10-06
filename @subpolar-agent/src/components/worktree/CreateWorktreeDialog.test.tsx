import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateWorktreeDialog } from './CreateWorktreeDialog'
import { worktreesApi as api } from '@/api/worktrees'
vi.mock('@/api/worktrees', () => ({ worktreesApi: { sources: vi.fn(), create: vi.fn(), createSession: vi.fn(), refreshRemote: vi.fn() } }))
const sha = 'a'.repeat(40)
const created = { repositoryId: '123456789012345', projectId: 7, worktree: { id: 'worktree', path: '/projects/worktrees/owned', branch: 'feature/new', baseRef: 'refs/remotes/company/main', baseSha: sha } }
function mount() { render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><CreateWorktreeDialog sessionId="parent" agent="master" /></QueryClientProvider></MemoryRouter>) }
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.sources).mockResolvedValue({ repositoryId: 'source', repository: { head: sha }, remotes: ['company'], branches: [
    { name: 'main', ref: 'refs/heads/main', current: true, remote: false, sha, target: 'company/main' },
    { name: 'company/main', ref: 'refs/remotes/company/main', current: false, remote: true, sha },
  ] })
  vi.mocked(api.create).mockResolvedValue(created)
  vi.mocked(api.createSession).mockResolvedValue({ session: { id: 'new-session', projectId: 7 } })
})
describe('create worktree dialog', () => {
  it('uses displayed full refs and SHA, requires approval, and retries session attachment without recreating the worktree', async () => {
    vi.mocked(api.createSession).mockRejectedValueOnce(new Error('Model unavailable'))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'New worktree' }))
    await screen.findByText(`Commit: ${sha}`)
    fireEvent.change(screen.getByLabelText('Source reference'), { target: { value: 'refs/remotes/company/main' } })
    fireEvent.change(screen.getByLabelText('New branch'), { target: { value: 'feature/new' } })
    expect(screen.getByRole('button', { name: 'Create worktree and session' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Create worktree and session' }))
    await screen.findByRole('alert')
    expect(api.create).toHaveBeenCalledWith('source', { branch: 'feature/new', sourceRef: 'refs/remotes/company/main', expectedSha: sha, approved: true })
    expect(api.createSession).toHaveBeenCalledWith(created, 'master')
    fireEvent.click(screen.getByRole('button', { name: 'Retry new session' }))
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(2))
    expect(api.create).toHaveBeenCalledTimes(1)
  })
  it.each(['HEAD', 'refs/heads/main'])('creates from %s with the displayed SHA and no implicit upstream', async sourceRef => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'New worktree' })); await screen.findByText(`Commit: ${sha}`)
    expect(screen.getByRole('option', { name: 'main (tracks company/main)' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Source reference'), { target: { value: sourceRef } })
    fireEvent.change(screen.getByLabelText('New branch'), { target: { value: 'feature/new' } })
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Create worktree and session' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('source', { branch: 'feature/new', sourceRef, expectedSha: sha, approved: true }))
  })
  it('does not permit creation from an unborn HEAD', async () => {
    vi.mocked(api.sources).mockResolvedValue({ repositoryId: 'source', repository: { head: null }, branches: [], remotes: [] })
    mount(); fireEvent.click(screen.getByRole('button', { name: 'New worktree' })); await screen.findByText('Commit: No commit available')
    fireEvent.change(screen.getByLabelText('New branch'), { target: { value: 'feature/new' } }); fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Create worktree and session' })).toBeDisabled()
    expect(api.create).not.toHaveBeenCalled()
  })
  it('refreshes cached refs explicitly and surfaces unavailable network refresh without claiming success', async () => {
    vi.mocked(api.refreshRemote).mockRejectedValue(new Error('Policy-aware transport unavailable'))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'New worktree' })); await screen.findByText(`Commit: ${sha}`)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh local references' }))
    await waitFor(() => expect(api.sources).toHaveBeenCalledTimes(2))
    fireEvent.change(screen.getByLabelText('Remote to refresh'), { target: { value: 'company' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fetch remote' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Fetch remote' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Policy-aware transport unavailable')
    expect(api.refreshRemote).toHaveBeenCalledWith('source', 'company')
    expect(api.sources).toHaveBeenCalledTimes(2)
  })
})
