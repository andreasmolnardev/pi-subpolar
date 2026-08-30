import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn()

const mocks = vi.hoisted(() => ({
  templates: [] as Array<{ id: number; title: string; description: string; category: string; cadenceHint: string; suggestedName: string; suggestedDescription: string; prompt: string }>,
  useDeletePromptTemplateMutate: vi.fn(),
}))

vi.mock('@/hooks/usePromptTemplates', () => ({
  usePromptTemplates: () => ({ data: mocks.templates, isLoading: false }),
  useCreatePromptTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdatePromptTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePromptTemplate: () => ({ mutate: mocks.useDeletePromptTemplateMutate, isPending: false }),
}))

vi.mock('@/api/providers', () => ({
  getProvidersWithModels: () => Promise.resolve([]),
}))

vi.mock('@/api/subpolar', () => ({
  createSubpolarClient: () => ({
    listAgents: () => Promise.resolve([]),
    getConfig: () => Promise.resolve(null),
  }),
}))

vi.mock('@/api/settings', () => ({
  settingsApi: {
    listManagedSkills: () => Promise.resolve([]),
  },
}))

vi.mock('@/api/projects', () => ({
  listProjects: () => Promise.resolve([]),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('automationJobDialog — assistant create guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders General Chat as the first repository option', async () => {
    const onRepoChange = vi.fn()
    const onSubmit = vi.fn()
    const onOpenChange = vi.fn()
    const user = userEvent.setup()

    render(
      <automationJobDialog
        open
        onOpenChange={onOpenChange}
        showRepoSelector
        repoId={undefined}
        onRepoChange={onRepoChange}
        onSubmit={onSubmit}
        isSaving={false}
      />,
      { wrapper: createWrapper() },
    )

    // Open the repo combobox by clicking the chevron/input
    const repoInput = screen.getByPlaceholderText('Select a repository')
    await user.click(repoInput)

    // The dropdown should open and show "General Chat" as an option
    await waitFor(() => {
      expect(screen.getByText('General Chat')).toBeInTheDocument()
    })
    // General Chat description should also be visible
    expect(screen.getByText('Built-in assistant')).toBeInTheDocument()
  })

  it('disables submit when no repo is selected, enables when General Chat repo is selected', async () => {
    const onRepoChange = vi.fn()
    const onSubmit = vi.fn()
    const user = userEvent.setup()

    const { rerender } = render(
      <automationJobDialog
        open
        onOpenChange={vi.fn()}
        showRepoSelector
        repoId={undefined}
        onRepoChange={onRepoChange}
        onSubmit={onSubmit}
        isSaving={false}
      />,
      { wrapper: createWrapper() },
    )

    // Wait for queries to settle
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create automation/i })).toBeDisabled()
    })

    // Fill in required name field
    const nameInput = screen.getByLabelText('Name')
    await user.type(nameInput, 'Test General Chat Job')

    // Switch to Prompt tab to fill prompt
    const promptTab = screen.getByRole('tab', { name: 'Prompt' })
    await user.click(promptTab)

    // Fill in required prompt field
    const promptInput = screen.getByRole('textbox', { name: 'Prompt' })
    await user.type(promptInput, 'Run a test analysis')

    // Submit button should still be disabled (repoId is undefined)
    const submitButton = screen.getByRole('button', { name: /Create automation/i })
    expect(submitButton).toBeDisabled()

    // Re-render with repoId={0} (General Chat selected) — name and prompt state persists
    rerender(
      <automationJobDialog
        open
        onOpenChange={vi.fn()}
        showRepoSelector
        repoId={0}
        onRepoChange={onRepoChange}
        onSubmit={onSubmit}
        isSaving={false}
      />,
    )

    // Submit button should now be enabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create automation/i })).not.toBeDisabled()
    })
  })
})
