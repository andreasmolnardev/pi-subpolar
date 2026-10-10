import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { SessionWorkspaceChanges } from './SessionWorkspaceChanges'
vi.mock('@/api/session-workspace', () => ({ sessionWorkspaceApi: { get: vi.fn().mockResolvedValue({ isGit: false, files: [], groups: [], additions: 0, deletions: 0 }) } }))
vi.mock('./RepositoryContext', () => ({ ProviderBrowserPanel: () => <p>Repository provider browsing</p>, RepositoryContext: () => null }))
vi.mock('@/components/agent-browser/LiveBrowser', () => ({ LiveBrowser: ({ scope, enabled }: { scope: { sessionId: string }; enabled: boolean }) => <p>Live viewer {scope.sessionId} {enabled ? 'active' : 'paused'}</p> }))
describe('workspace browser views', () => {
  it('adds Live Browser through existing launcher and preserves Code Browser', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><SessionWorkspaceChanges sessionId="conversation" /></QueryClientProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Add sidebar view' }))
    fireEvent.click(await screen.findByRole('button', { name: '+ Live Browser' }))
    expect(await screen.findByRole('tab', { name: 'Live Browser' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Live viewer conversation active')).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Browser' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace panel' }))
    expect(screen.getByText('Live viewer conversation paused')).not.toBeVisible()
    view.unmount()
  })
})
