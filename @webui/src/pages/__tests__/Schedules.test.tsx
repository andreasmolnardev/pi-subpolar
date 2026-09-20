import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Automations } from '../Automations'

const mocks = vi.hoisted(() => ({
  useAutomationTarget: vi.fn(),
  useRepoAutomations: vi.fn(),
  useRepoAutomation: vi.fn(),
  useRepoAutomationRuns: vi.fn(),
  useRepoAutomationRun: vi.fn(),
  useCreateRepoAutomation: vi.fn(),
  useUpdateRepoAutomation: vi.fn(),
  useDeleteRepoAutomation: vi.fn(),
  useRunRepoAutomation: vi.fn(),
  useCancelRepoAutomationRun: vi.fn(),
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
  useRepoAutomations: (...args: Parameters<typeof mocks.useRepoAutomations>) => mocks.useRepoAutomations(...args) ?? mocks.useRepoautomations(...args),
  useRepoAutomation: (...args: Parameters<typeof mocks.useRepoAutomation>) => mocks.useRepoAutomation(...args) ?? mocks.useRepoautomation(...args),
  useRepoAutomationRuns: (...args: Parameters<typeof mocks.useRepoAutomationRuns>) => mocks.useRepoAutomationRuns(...args) ?? mocks.useRepoautomationRuns(...args),
  useRepoAutomationRun: (...args: Parameters<typeof mocks.useRepoAutomationRun>) => mocks.useRepoAutomationRun(...args) ?? mocks.useRepoautomationRun(...args),
  useCreateRepoAutomation: (...args: Parameters<typeof mocks.useCreateRepoAutomation>) => mocks.useCreateRepoAutomation(...args) ?? mocks.useCreateRepoautomation(...args),
  useUpdateRepoAutomation: (...args: Parameters<typeof mocks.useUpdateRepoAutomation>) => mocks.useUpdateRepoAutomation(...args) ?? mocks.useUpdateRepoautomation(...args),
  useDeleteRepoAutomation: (...args: Parameters<typeof mocks.useDeleteRepoAutomation>) => mocks.useDeleteRepoAutomation(...args) ?? mocks.useDeleteRepoautomation(...args),
  useRunRepoAutomation: (...args: Parameters<typeof mocks.useRunRepoAutomation>) => mocks.useRunRepoAutomation(...args) ?? mocks.useRunRepoautomation(...args),
  useCancelRepoAutomationRun: (...args: Parameters<typeof mocks.useCancelRepoAutomationRun>) => mocks.useCancelRepoAutomationRun(...args) ?? mocks.useCancelRepoautomationRun(...args),
}))

vi.mock('@/hooks/useProjectActivity', () => ({
  useProjectActivity: mocks.useRepoActivity,
}))

vi.mock('@/hooks/useAutomationUrlState', () => ({
  useAutomationUrlState: mocks.useAutomationUrlState,
}))

vi.mock('@/components/automations', () => ({
  AutomationJobDialog: vi.fn(({ onOpenChange }) => (
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
  AutomationTabMenu: vi.fn(() => <div>automationTabMenu</div>),
}))

function createMockAutomationUrlState(overrides: Record<string, unknown> = {}) {
  return {
    automationTab: 'jobs',
    setAutomationTab: vi.fn(),
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

const renderAutomations = (repoId: string, initialEntry = `/repos/${repoId}/automations`) => {
  const routePath = initialEntry.startsWith('/projects/') ? '/projects/:id/automations' : '/repos/:id/automations'
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path={routePath} element={<Automations />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: createWrapper() }
  )
}


describe('Automations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useAutomationUrlState.mockReturnValue(createMockAutomationUrlState())
    mocks.useCreateRepoautomation.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mocks.useUpdateRepoautomation.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mocks.useDeleteRepoautomation.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mocks.useRunRepoautomation.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mocks.useCancelRepoautomationRun.mockReturnValue({ mutate: vi.fn(), isPending: false })
  })

  it.each(['/projects/5/automations', '/repos/5/automations'])('renders the automation page for %s', (path) => {
    mocks.useAutomationTarget.mockReturnValue({
      automationTarget: { repoId: 5, kind: 'project', name: 'Project Five', subtitle: '/work/project-five', fullPath: '/work/project-five', backHref: '/projects/5' },
      isLoading: false,
      isError: false,
    })
       mocks.useRepoAutomations.mockReturnValue({ data: [], isLoading: false })
       mocks.useRepoAutomation.mockReturnValue({ data: undefined, isFetching: false })
       mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
       mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

    renderAutomations('5', path)

    expect(screen.getByText('Project Five')).toBeInTheDocument()
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
    mocks.useRepoAutomations.mockReturnValue({ data: [], isLoading: false })
    mocks.useRepoAutomation.mockReturnValue({ data: undefined, isFetching: false })
    mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
    mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('0')

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
       mocks.useRepoAutomations.mockReturnValue({ data: [], isLoading: false })
       mocks.useRepoAutomation.mockReturnValue({ data: undefined, isFetching: false })
       mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
       mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('0')

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
      mocks.useRepoAutomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('0')

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
      mocks.useAutomationUrlState.mockReturnValue(createMockAutomationUrlState({
        automationTab: 'detail',
      }))
      mocks.useRepoAutomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })
      mocks.useRunRepoAutomation.mockReturnValue({ mutate: mutateMock, isPending: false })

      renderAutomations('0')

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
      mocks.useRepoAutomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('5')

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
      mocks.useRepoAutomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('5')

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
      mocks.useRepoAutomations.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('5', '/repos/5/automations?returnTo=%2Frepos%2F5%2Fsessions%2Fabc%3Fassistant%3D1')

      fireEvent.click(screen.getAllByRole('button')[0])

      expect(mockNavigate).toHaveBeenCalledWith('/repos/5/sessions/abc?assistant=1')
    })

    it('normalizes prompts tab to jobs when jobs exist', () => {
      const setAutomationTab = vi.fn()
      mocks.useAutomationUrlState.mockReturnValue(createMockAutomationUrlState({
        automationTab: 'prompts',
        jobId: 123,
        setAutomationTab,
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
      mocks.useRepoAutomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('5')

      // The normalization effect should have reset the tab to 'jobs'
      expect(setAutomationTab).toHaveBeenCalledWith('jobs')
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
      mocks.useRepoAutomations.mockReturnValue({ data: undefined, isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('999')

      expect(screen.getByText('Repository not found')).toBeInTheDocument()
    })

    it('renders not found fallback for assistant', () => {
      mocks.useAutomationTarget.mockReturnValue({
        automationTarget: undefined,
        isLoading: false,
        isError: true,
      })
      mocks.useRepoAutomations.mockReturnValue({ data: undefined, isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: undefined, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('0')

      expect(screen.getByText('General Chat not found')).toBeInTheDocument()
    })
  })

  describe('dialog interactions', () => {
    it('closing automationJobDialog calls closeDialog', () => {
      const closeDialog = vi.fn()
      mocks.useAutomationUrlState.mockReturnValue(createMockAutomationUrlState({
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
      mocks.useRepoAutomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('5')

      const closeButton = screen.getByTestId('close-job-dialog')
      fireEvent.click(closeButton)

      expect(closeDialog).toHaveBeenCalled()
    })

    it('delete mutation success calls closeDialog', () => {
      const closeDialog = vi.fn()
      const deleteMutate = vi.fn((_args, { onSuccess }) => { onSuccess() })
      mocks.useAutomationUrlState.mockReturnValue(createMockAutomationUrlState({
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
      mocks.useRepoAutomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })
      mocks.useDeleteRepoAutomation.mockReturnValue({ mutate: deleteMutate, isPending: false })

      renderAutomations('5')

      // The DeleteDialog renders a Confirm button that calls onConfirm.
      // Find the confirm button and click it to trigger handleDelete.
      const confirmButton = screen.getByText('Delete')
      fireEvent.click(confirmButton)

      // The mutation runs and onSuccess calls closeDialog
      expect(closeDialog).toHaveBeenCalled()
    })

    it('edit button on JobDetailTab calls openEditJob', () => {
      const openEditJob = vi.fn()
      mocks.useAutomationUrlState.mockReturnValue(createMockAutomationUrlState({
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
      mocks.useRepoAutomations.mockReturnValue({ data: [mockJob], isLoading: false })
      mocks.useRepoAutomation.mockReturnValue({ data: mockJob, isFetching: false })
      mocks.useRepoAutomationRuns.mockReturnValue({ data: [], isLoading: false })
      mocks.useRepoAutomationRun.mockReturnValue({ data: undefined, isLoading: false })

      renderAutomations('5')

      const editButton = screen.getByTestId('edit-job')
      fireEvent.click(editButton)

      expect(openEditJob).toHaveBeenCalledWith(123)
    })
  })
})
