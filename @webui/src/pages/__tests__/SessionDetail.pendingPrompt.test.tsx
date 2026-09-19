import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SessionDetail } from '../SessionDetail'
import {
  clearPendingSessionPrompt,
  loadPendingSessionPrompt,
  savePendingSessionPrompt,
} from '@/lib/pending-session-prompt'

const mocks = vi.hoisted(() => ({
  sendPrompt: vi.fn(),
}))

vi.mock('@/hooks/usePiHarness', () => ({
  useSession: vi.fn(() => ({
    data: { title: 'Test session' },
    isLoading: false,
  })),
  useAbortSession: vi.fn(() => ({ mutate: vi.fn() })),
  useSendPrompt: vi.fn(() => ({ mutate: mocks.sendPrompt, isPending: false })),
  useSessionQueue: vi.fn(() => ({ data: [] })),
  useRemoveQueueEntry: vi.fn(() => ({ mutate: vi.fn() })),
  useRetryQueueEntry: vi.fn(() => ({ mutate: vi.fn() })),
  useReorderQueueEntry: vi.fn(() => ({ mutate: vi.fn() })),
  useClearQueue: vi.fn(() => ({ mutate: vi.fn() })),
}))

vi.mock('@/api/projects', () => ({
  getProject: vi.fn(() => Promise.resolve({
    id: 1,
    name: 'Test project',
    directory: '/repo',
    fullPath: '/repo',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  })),
  hasProjectId: vi.fn(() => true),
  listProjects: vi.fn(() => Promise.resolve([])),
}))

vi.mock('@/hooks/useSSE', () => ({
  useSSE: vi.fn(() => ({ isConnected: true, isReconnecting: false })),
}))

vi.mock('@/hooks/useSessionTranscript', () => ({
  useSessionTranscript: vi.fn(() => ({
    messages: [],
    isLoading: false,
    hasOlder: false,
    loadOlder: vi.fn(),
    isConnected: true,
  })),
}))

vi.mock('@/hooks/useProjectActivity', () => ({ useProjectActivity: vi.fn() }))
vi.mock('@/hooks/useModelSelection', () => ({
  useModelSelection: vi.fn(() => ({ model: null, modelString: null })),
}))
vi.mock('@/hooks/useSessionAgent', () => ({
  useSessionAgent: vi.fn(() => ({ agent: undefined, model: undefined, permission: undefined })),
}))
vi.mock('@/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: vi.fn(() => ({ leaderActive: false })),
}))
vi.mock('@/hooks/useAutoScroll', () => ({
  useAutoScroll: vi.fn(() => ({ scrollToBottom: vi.fn() })),
}))
vi.mock('@/hooks/useMobile', () => ({ useMobile: vi.fn(() => false) }))
vi.mock('@/hooks/useVisualViewport', () => ({ useVisualViewport: vi.fn(() => ({ keyboardHeight: 0 })) }))
vi.mock('@/hooks/useSidebarAction', () => ({ useSidebarAction: vi.fn() }))

vi.mock('@/stores/uiStateStore', () => ({ useUIState: vi.fn(() => false) }))
vi.mock('@/stores/sessionStatusStore', () => ({
  useSessionStatusForSession: vi.fn(() => ({ type: 'idle' })),
}))

vi.mock('@/contexts/EventContext', () => ({
  usePermissions: vi.fn(() => ({
    pendingCount: 0,
    respond: vi.fn(),
    getForSession: vi.fn(() => null),
    syncForSession: vi.fn(),
  })),
  useQuestions: vi.fn(() => ({
    current: null,
    reply: vi.fn(),
    reject: vi.fn(),
    syncForSession: vi.fn(),
  })),
}))

vi.mock('@/components/chat/ChatInputBar', () => ({
  ChatInputBar: vi.fn(() => null),
}))
vi.mock('@/components/message/MessageThread', () => ({ MessageThread: vi.fn(() => null) }))
vi.mock('@/components/message/MessageSkeleton', () => ({ MessageSkeleton: vi.fn(() => null) }))
vi.mock('@/components/message/SessionTodoDisplay', () => ({ SessionTodoDisplay: vi.fn(() => null) }))
vi.mock('@/components/session/SessionList', () => ({ SessionList: vi.fn(() => null) }))
vi.mock('@/components/session/SessionMoreButton', () => ({ SessionMoreButton: vi.fn(() => null) }))
vi.mock('@/components/session/ContextUsageIndicator', () => ({ ContextUsageIndicator: vi.fn(() => null) }))
vi.mock('@/components/session/QuestionPrompt', () => ({ QuestionPrompt: vi.fn(() => null) }))
vi.mock('@/components/session/MinimizedQuestionIndicator', () => ({ MinimizedQuestionIndicator: vi.fn(() => null) }))
vi.mock('@/components/session/PermissionRequestDialog', () => ({ PermissionRequestDialog: vi.fn(() => null) }))
vi.mock('@/components/notifications/PendingActionsGroup', () => ({ PendingActionsGroup: vi.fn(() => null) }))
vi.mock('@/components/session/SessionSendErrorBanner', () => ({ SessionSendErrorBanner: vi.fn(() => null) }))
vi.mock('@/components/project/ProjectNotFoundDialog', () => ({ ProjectNotFoundDialog: vi.fn(() => null) }))

const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

const renderSession = (sessionID = 'session-1') => render(
  <MemoryRouter initialEntries={[`/repos/1/sessions/${sessionID}`]}>
    <QueryClientProvider client={createQueryClient()}>
      <Routes>
        <Route path="/repos/:id/sessions/:sessionId" element={<SessionDetail />} />
      </Routes>
    </QueryClientProvider>
  </MemoryRouter>,
)

describe('SessionDetail interrupted first-send handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the interrupted state without replaying the stored message on reload', async () => {
    savePendingSessionPrompt('session-1', {
      prompt: 'Run this once',
      messageID: 'optimistic_user_original',
      status: 'interrupted',
    })

    renderSession()

    expect(await screen.findByTestId('interrupted-prompt-state')).toBeTruthy()
    expect(mocks.sendPrompt).not.toHaveBeenCalled()
  })

  it.each(['pending', 'running'] as const)('keeps a %s delivery in flight and does not replay it after reload', async (deliveryState) => {
    savePendingSessionPrompt('session-1', {
      prompt: 'Run this once',
      messageID: 'optimistic_user_original',
    })

    renderSession()

    expect(await screen.findByTestId('in-flight-prompt-state')).toBeTruthy()
    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1)
    const [, options] = mocks.sendPrompt.mock.calls[0]
    await act(async () => {
      options.onSuccess({ state: deliveryState })
    })

    await waitFor(() => {
      expect(loadPendingSessionPrompt('session-1')).toMatchObject({
        messageID: 'optimistic_user_original',
        status: 'in-flight',
      })
    })

    cleanup()
    renderSession()

    expect(await screen.findByTestId('in-flight-prompt-state')).toBeTruthy()
    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('retries with a new ID and preserves the handoff until success', async () => {
    savePendingSessionPrompt('session-1', {
      prompt: 'Run this once',
      messageID: 'optimistic_user_original',
      status: 'interrupted',
    })

    renderSession()
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1)
    const [variables, options] = mocks.sendPrompt.mock.calls[0]
    expect(variables).toMatchObject({
      sessionID: 'session-1',
      prompt: 'Run this once',
      messageID: expect.stringMatching(/^optimistic_user_/),
    })
    expect(variables.messageID).not.toBe('optimistic_user_original')
    expect(variables.queued).toBeUndefined()
    expect(loadPendingSessionPrompt('session-1')).toMatchObject({
      messageID: variables.messageID,
      status: 'in-flight',
    })

    await act(async () => {
      options.onSuccess({ state: 'completed' })
    })

    await waitFor(() => {
      expect(loadPendingSessionPrompt('session-1')).toBeUndefined()
        expect(screen.queryByTestId('interrupted-prompt-state')).toBeNull()
    })
  })

  it('keeps a failed retry available and supports explicit discard', async () => {
    savePendingSessionPrompt('session-1', {
      prompt: 'Run this once',
      messageID: 'optimistic_user_original',
      status: 'interrupted',
    })

    renderSession()
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    const [, options] = mocks.sendPrompt.mock.calls[0]
    await act(async () => {
      options.onError({ code: 'DELIVERY_UNKNOWN', message: 'still uncertain' })
    })

    await waitFor(() => {
      expect(screen.getByTestId('interrupted-prompt-state')).toBeTruthy()
      expect(loadPendingSessionPrompt('session-1')).toMatchObject({ status: 'unknown' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() => {
      expect(loadPendingSessionPrompt('session-1')).toBeUndefined()
      expect(screen.queryByTestId('interrupted-prompt-state')).toBeNull()
    })
  })
})
