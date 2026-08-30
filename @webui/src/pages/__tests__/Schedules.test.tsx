import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => ({
  useAutomationTarget: vi.fn(),
  useRepoautomations: vi.fn(),
  useRepoautomation: vi.fn(),
  useRepoautomationRuns: vi.fn(),
  useRepoautomationRun: vi.fn(),
  useCreateRepoautomation: vi.fn(),
  useUpdateRepoautomation: vi.fn(),
  useDeleteRepoautomation: vi.fn(),
  useRunRepoautomation: vi.fn(),
  useCancelRepoautomationRun: vi.fn(),
  useRepoActivity: vi.fn(),
  useAutomationUrlState: vi.fn(),
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal('react-router-dom')),
  useNavigate: () => mockNavigate,
}))

vi.mock('@/hooks/useAutomationTarget', () => ({
  useAutomationTarget: mocks.useAutomationTarget,
}))

vi.mock('@/hooks/useAutomations', () => ({
  useRepoautomations: mocks.useRepoautomations,
  useRepoautomation: mocks.useRepoautomation,
  useRepoautomationRuns: mocks.useRepoautomationRuns,
  useRepoautomationRun: mocks.useRepoautomationRun,
  useCreateRepoautomation: mocks.useCreateRepoautomation,
  useUpdateRepoautomation: mocks.useUpdateRepoautomation,
  useDeleteRepoautomation: mocks.useDeleteRepoautomation,
  useRunRepoautomation: mocks.useRunRepoautomation,
  useCancelRepoautomationRun: mocks.useCancelRepoautomationRun,
}))

vi.mock('@/hooks/useProjectActivity', () => ({
  useProjectActivity: mocks.useRepoActivity,
}))

vi.mock('@/hooks/useAutomationUrlState', () => ({
  useAutomationUrlState: mocks.useAutomationUrlState,
}))

vi.mock('@/components/automations', () => ({
  automationJobDialog: vi.fn(({ onOpenChange }) => (
    <div>
      automationJobDialog
      <button onClick={() => onOpenChange(false)} data-testid="close-job-dialog">Close</button>
    </div>
  )),
  JobsTab: vi.fn(({ onSelectJob }) => (
    <div>
      <button onClick={() => onSelectJob(123)} data-testid="select-job">Select Job</button>
    </div>
  )),
  JobDetailTab: vi.fn(({ onEdit, onDelete, onRunNow }) => (
    <div>
      <button onClick={onRunNow} data-testid="run-now">Run Now</button>
      <button onClick={() => onEdit({ id: 123 })} data-testid="edit-job">Edit Job</button>
      <button onClick={() => onDelete(123)} data-testid="delete-job">Delete Job</button>
    </div>
  )),
  RunHistoryTab: vi.fn(() => <div>RunHistoryTab</div>),
  automationTabMenu: vi.fn(() => <div>automationTabMenu</div>),
}))

function createMockautomationUrlState(overrides: Record<string, unknown> = {}) {
  return {
    automationTab: 'jobs',
    setautomationTab: vi.fn(),
    dialog: null,
    promptDialog: null,
    jobId: null,
    runId: null,
    templateId: null,
    openNewJob: vi.fn(),
    openEditJob: vi.fn(),
    openDeleteJob: vi.fn(),
    openNewTemplate: vi.fn(),
    openEditTemplate: vi.fn(),
    openDeleteTemplate: vi.fn(),
    openImportTemplate: vi.fn(),
    closeDialog: vi.fn(),
    closePromptDialog: vi.fn(),
    selectRun: vi.fn(),
    selectJobAndView: vi.fn(),
    selectJobAndCloseDialog: vi.fn(),
    replaceUrlParams: vi.fn(),
    ...overrides,
  }
}

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

const renderautomations = (repoId: string, initialEntry = `/repos/${repoId}/automations`) => {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/repos/:id/automations" element={<automations />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: createWrapper() }
  )
}

describe('automations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useAutomationUrlState.mockReturnValue(createMockautomationUrlState())
    mocks.useCreateRepoautomation.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mocks.useUpdateRepoautomation.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mocks.useDeleteRepoautomation.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mocks.useRunRepoautomation.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mocks.useCancelRepoautomationRun.mockReturnValue({ mutate: vi.fn(), isPending: false })
  })

  describe('assistant automation target (repoId=0)', () => {
    it('renders assistant title and subtitle', () => {
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 0,
          kind: 'assistant',
          name: 'General Chat',
          subtitle: 'Built-in assistant',
          fullPath: '/abs/assistant',
          backHref: '/assistant',
        },
        isLoading: false,
        isError: false,
      })
      mocks.useRepoautomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('0')

      expect(screen.getByText('General Chat')).toBeInTheDocument()
      expect(screen.getByText('Built-in assistant')).toBeInTheDocument()
    })

    it('does not render Repository not found', () => {
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 0,
          kind: 'assistant',
          name: 'General Chat',
          subtitle: 'Built-in assistant',
          fullPath: '/abs/assistant',
          backHref: '/assistant',
        },
        isLoading: false,
        isError: false,
      })
      mocks.useRepoautomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('0')

      expect(screen.queryByText('Repository not found')).not.toBeInTheDocument()
    })

    it('renders back button with correct href', () => {
      mockNavigate.mockClear()

      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 0,
          kind: 'assistant',
          name: 'General Chat',
          subtitle: 'Built-in assistant',
          fullPath: '/abs/assistant',
          backHref: '/assistant',
        },
        isLoading: false,
        isError: false,
      })
      mocks.useRepoautomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('0')

      const backButton = screen.getAllByRole('button')[0]
      expect(backButton).toBeInTheDocument()
      fireEvent.click(backButton)
      expect(mockNavigate).toHaveBeenCalledWith('/assistant')
    })

    it('calls runMutation with repoId=0 when Run Now is clicked', () => {
      const mutateMock = vi.fn()
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 0,
          kind: 'assistant',
          name: 'General Chat',
          subtitle: 'Built-in assistant',
          fullPath: '/abs/assistant',
          backHref: '/assistant',
        },
        isLoading: false,
        isError: false,
      })
      const mockJob = {
        id: 123,
        name: 'Test Job',
        repoId: 0,
        cronExpression: null,
        intervalMinutes: 30,
        timezone: 'UTC',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        automationMode: 'interval' as const,
        agentSlug: null,
        prompt: 'test',
        triggerSource: 'manual' as const,
        lastRunAt: null,
        nextRunAt: null,
        skillMetadata: null,
      }
      mocks.useAutomationUrlState.mockReturnValue(createMockautomationUrlState({
        automationTab: 'detail',
      }))
      mocks.useRepoautomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })
      mocks.useRunRepoautomation.mockReturnValue({ mutate: mutateMock, isPending: false })

      renderautomations('0')

      const runNowButton = screen.getByTestId('run-now')
      runNowButton.click()

      expect(mutateMock).toHaveBeenCalledWith({ repoId: 0, jobId: 123 }, expect.any(Object))
    })
  })

  describe('repo automation target (repoId=5)', () => {
    it('renders repo name and subtitle', () => {
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 5,
          kind: 'repo',
          name: 'my-repo',
          subtitle: 'repos/my-repo',
          fullPath: '/abs/repos/my-repo',
          backHref: '/repos/5',
        },
        isLoading: false,
        isError: false,
      })
      mocks.useRepoautomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('5')

      expect(screen.getByText('my-repo')).toBeInTheDocument()
      expect(screen.getByText('repos/my-repo')).toBeInTheDocument()
    })

    it('renders back button with correct href', () => {
      mockNavigate.mockClear()

      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 5,
          kind: 'repo',
          name: 'my-repo',
          subtitle: 'repos/my-repo',
          fullPath: '/abs/repos/my-repo',
          backHref: '/repos/5',
        },
        isLoading: false,
        isError: false,
      })
      mocks.useRepoautomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('5')

      const backButton = screen.getAllByRole('button')[0]
      expect(backButton).toBeInTheDocument()
      fireEvent.click(backButton)
      expect(mockNavigate).toHaveBeenCalledWith('/repos/5')
    })

    it('uses returnTo param for back button when present', () => {
      mockNavigate.mockClear()

      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 5,
          kind: 'repo',
          name: 'my-repo',
          subtitle: 'repos/my-repo',
          fullPath: '/abs/repos/my-repo',
          backHref: '/repos/5',
        },
        isLoading: false,
        isError: false,
      })
      mocks.useRepoautomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('5', '/repos/5/automations?returnTo=%2Frepos%2F5%2Fsessions%2Fabc%3Fassistant%3D1')

      fireEvent.click(screen.getAllByRole('button')[0])

      expect(mockNavigate).toHaveBeenCalledWith('/repos/5/sessions/abc?assistant=1')
    })

    it('normalizes prompts tab to jobs when jobs exist', () => {
      const setautomationTab = vi.fn()
      mocks.useAutomationUrlState.mockReturnValue(createMockautomationUrlState({
        automationTab: 'prompts',
        jobId: 123,
        setautomationTab,
      }))
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 5,
          kind: 'repo',
          name: 'my-repo',
          subtitle: 'repos/my-repo',
          fullPath: '/abs/repos/my-repo',
          backHref: '/repos/5',
        },
        isLoading: false,
        isError: false,
      })
      const mockJob = {
        id: 123,
        name: 'Test Job',
        repoId: 5,
        cronExpression: null,
        intervalMinutes: 30,
        timezone: 'UTC',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        automationMode: 'interval' as const,
        agentSlug: null,
        prompt: 'test',
        triggerSource: 'manual' as const,
        lastRunAt: null,
        nextRunAt: null,
        skillMetadata: null,
      }
      mocks.useRepoautomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('5')

      // The normalization effect should have reset the tab to 'jobs'
      expect(setautomationTab).toHaveBeenCalledWith('jobs')
      // Jobs tab content should render instead of blank
      expect(screen.getByText('Select Job')).toBeInTheDocument()
    })
  })

  describe('automation target not found', () => {
    it('renders not found fallback for real repo', () => {
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: undefined,
        isLoading: false,
        isError: true,
      })
      mocks.useRepoautomations.mockReturnValue({ data: undefined, isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('999')

      expect(screen.getByText('Repository not found')).toBeInTheDocument()
    })

    it('renders not found fallback for assistant', () => {
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: undefined,
        isLoading: false,
        isError: true,
      })
      mocks.useRepoautomations.mockReturnValue({ data: undefined, isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('0')

      expect(screen.getByText('General Chat not found')).toBeInTheDocument()
    })
  })

  describe('dialog interactions', () => {
    it('closing automationJobDialog calls closeDialog', () => {
      const closeDialog = vi.fn()
      mocks.useAutomationUrlState.mockReturnValue(createMockautomationUrlState({
        dialog: 'edit',
        jobId: 123,
        closeDialog,
      }))
      const mockJob = {
        id: 123,
        name: 'Test Job',
        repoId: 5,
        cronExpression: null,
        intervalMinutes: 30,
        timezone: 'UTC',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        automationMode: 'interval' as const,
        agentSlug: null,
        prompt: 'test',
        triggerSource: 'manual' as const,
        lastRunAt: null,
        nextRunAt: null,
        skillMetadata: null,
      }
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 5,
          kind: 'repo',
          name: 'my-repo',
          subtitle: 'repos/my-repo',
          fullPath: '/abs/repos/my-repo',
          backHref: '/repos/5',
        },
        isLoading: false,
        isError: false,
      })
      mocks.useRepoautomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('5')

      const closeButton = screen.getByTestId('close-job-dialog')
      fireEvent.click(closeButton)

      expect(closeDialog).toHaveBeenCalled()
    })

    it('delete mutation success calls closeDialog', () => {
      const closeDialog = vi.fn()
      const deleteMutate = vi.fn((_args, { onSuccess }) => { onSuccess() })
      mocks.useAutomationUrlState.mockReturnValue(createMockautomationUrlState({
        dialog: 'delete',
        jobId: 123,
        closeDialog,
      }))
      const mockJob = {
        id: 123,
        name: 'Test Job',
        repoId: 5,
        cronExpression: null,
        intervalMinutes: 30,
        timezone: 'UTC',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        automationMode: 'interval' as const,
        agentSlug: null,
        prompt: 'test',
        triggerSource: 'manual' as const,
        lastRunAt: null,
        nextRunAt: null,
        skillMetadata: null,
      }
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 5,
          kind: 'repo',
          name: 'my-repo',
          subtitle: 'repos/my-repo',
          fullPath: '/abs/repos/my-repo',
          backHref: '/repos/5',
        },
        isLoading: false,
        isError: false,
      })
      mocks.useRepoautomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })
      mocks.useDeleteRepoautomation.mockReturnValue({ mutate: deleteMutate, isPending: false })

      renderautomations('5')

      // The DeleteDialog renders a Confirm button that calls onConfirm.
      // Find the confirm button and click it to trigger handleDelete.
      const confirmButton = screen.getByText('Delete')
      fireEvent.click(confirmButton)

      // The mutation runs and onSuccess calls closeDialog
      expect(closeDialog).toHaveBeenCalled()
    })

    it('edit button on JobDetailTab calls openEditJob', () => {
      const openEditJob = vi.fn()
      mocks.useAutomationUrlState.mockReturnValue(createMockautomationUrlState({
        automationTab: 'detail',
        jobId: 123,
        openEditJob,
      }))
      const mockJob = {
        id: 123,
        name: 'Test Job',
        repoId: 5,
        cronExpression: null,
        intervalMinutes: 30,
        timezone: 'UTC',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        automationMode: 'interval' as const,
        agentSlug: null,
        prompt: 'test',
        triggerSource: 'manual' as const,
        lastRunAt: null,
        nextRunAt: null,
        skillMetadata: null,
      }
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: {
          repoId: 5,
          kind: 'repo',
          name: 'my-repo',
          subtitle: 'repos/my-repo',
          fullPath: '/abs/repos/my-repo',
          backHref: '/repos/5',
        },
        isLoading: false,
        isError: false,
      })
      mocks.useRepoautomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoautomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoautomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoautomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderautomations('5')

      const editButton = screen.getByTestId('edit-job')
      fireEvent.click(editButton)

      expect(openEditJob).toHaveBeenCalledWith(123)
    })
  })
})
