import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSession } from '../NewSession'

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  resolveContext: vi.fn(),
  fetchWorktrees: vi.fn(),
  fetchBranches: vi.fn(),
  createWorktree: vi.fn(),
  getProviders: vi.fn(),
}))
vi.mock('@/api/projects', () => ({ listProjects: mocks.listProjects }))
vi.mock('@/api/new-session', () => ({ resolveNewSessionContext: mocks.resolveContext }))
vi.mock('@/api/git', () => ({ fetchRepositoryBranches: mocks.fetchBranches, fetchRepositoryWorktrees: mocks.fetchWorktrees }))
vi.mock('@/api/worktrees', () => ({ worktreesApi: { create: mocks.createWorktree } }))
vi.mock('@/api/providers', () => ({ getProviders: mocks.getProviders }))
vi.mock('@/hooks/usePiDurableHarness', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('@/hooks/useSettings', () => ({ useSettings: () => ({ preferences: {} }) }))
vi.mock('@/hooks/useSidebarAction', () => ({ useSidebarAction: vi.fn() }))
vi.mock('@/components/chat/ChatInputBar', () => ({
  ChatInputBar: (props: { projectId?: string; repositoryId?: string; worktreeId?: string }) => (
    <output data-testid="composer-selection" data-project={props.projectId} data-repository={props.repositoryId} data-worktree={props.worktreeId} />
  ),
}))

const sha = 'a'.repeat(40)
const project = { id: 1, repositoryId: 'stable-source-project', name: 'Repo', directory: '/repo', fullPath: '/repo', status: 'ready' as const, createdAt: 1, updatedAt: 1 }
const existingWorktreeProject = { id: 2, repositoryId: 'stable-active-project', name: 'Repo · feature/existing · active-id', directory: '/repo-feature', fullPath: '/repo-feature', status: 'ready' as const, createdAt: 2, updatedAt: 2 }
function mount() {
  render(<MemoryRouter initialEntries={['/new']}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><NewSession /></QueryClientProvider></MemoryRouter>)
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.resetAllMocks()
  mocks.resolveContext.mockResolvedValue({ project, agent: { id: 'agent', name: 'master' }, defaults: { permission: 'ask' } })
  mocks.listProjects.mockResolvedValue([project, existingWorktreeProject])
  mocks.getProviders.mockResolvedValue({ providers: [] })
  mocks.fetchWorktrees.mockResolvedValue({ worktrees: [
    { path: '/repo', branch: 'main', prunable: false },
    { path: '../repo-feature', branch: 'feature/existing', prunable: false },
  ] })
  mocks.fetchBranches.mockResolvedValue({ repository: { head: sha }, branches: [{ name: 'main', ref: 'refs/heads/main', current: true, remote: false, sha } ] })
  mocks.createWorktree.mockResolvedValue({ repositoryId: 'stable-linked-repo', projectId: 3, worktree: { id: 'owned-worktree', path: '/safe/owned-worktree', branch: 'feature/new' } })
})

describe('new-session workspace picker', () => {
  it('offers the current checkout and active worktrees from the authenticated repository API', async () => {
    mount()
    await screen.findByText('Repo')
    await waitFor(() => expect(screen.getByTestId('composer-selection')).toHaveAttribute('data-repository', 'stable-source-project'))
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }))
    fireEvent.click(screen.getAllByRole('combobox')[1]!)
    expect(await screen.findByRole('option', { name: 'Project root / current checkout' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'feature/existing' }))
    await waitFor(() => expect(screen.getByTestId('composer-selection')).toHaveAttribute('data-project', '2'))
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith('stable-source-project')
    await waitFor(() => expect(mocks.fetchWorktrees).toHaveBeenCalledWith('stable-active-project'))
    expect(screen.getByTestId('composer-selection')).toHaveAttribute('data-worktree', 'active-id')
    expect(screen.getByTestId('composer-selection')).toHaveAttribute('data-repository', 'stable-active-project')
  })

  it('creates an approved worktree and carries its server-issued IDs into first-send session creation props', async () => {
    mount()
    await screen.findByText('Repo')
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }))
    const triggers = screen.getAllByRole('combobox')
    fireEvent.click(triggers[1]!)
    fireEvent.click(await screen.findByRole('option', { name: 'New worktree…' }))
    await screen.findByText(`Commit: ${sha}`)
    expect(mocks.fetchBranches).toHaveBeenCalledWith('stable-source-project')
    fireEvent.change(screen.getByLabelText('New branch'), { target: { value: 'feature/new' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }))
    await waitFor(() => expect(mocks.createWorktree).toHaveBeenCalledWith('stable-source-project', {
      branch: 'feature/new', sourceRef: 'HEAD', expectedSha: sha, approved: true,
    }))
    await waitFor(() => expect(screen.getByTestId('composer-selection')).toHaveAttribute('data-worktree', 'owned-worktree'))
    expect(screen.getByTestId('composer-selection')).toHaveAttribute('data-repository', 'stable-linked-repo')
    expect(screen.getByTestId('composer-selection')).toHaveAttribute('data-project', '3')
    expect(screen.getByTestId('composer-selection')).not.toHaveAttribute('data-directory')
  })
})
