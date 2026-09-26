import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { formatSentTimestamp, MessageThread } from './MessageThread'
import { useUIState } from '@/stores/uiStateStore'

const mocks = vi.hoisted(() => ({
  useSessionStatus: vi.fn(),
  useSessionTodos: vi.fn(),
  useSettings: vi.fn(),
  usePermissions: vi.fn(),
  useQuestions: vi.fn(),
  useRefreshMessage: vi.fn(),
  useSessionAgent: vi.fn(),
}))

vi.mock('@/stores/sessionStatusStore', () => ({
  useSessionStatusForSession: () => mocks.useSessionStatus(),
}))

vi.mock('@/stores/sessionTodosStore', () => ({
  useSessionTodos: mocks.useSessionTodos,
}))

vi.mock('@/hooks/useSettings', () => ({
  useSettings: mocks.useSettings,
}))

vi.mock('@/contexts/EventContext', () => ({
  usePermissions: () => mocks.usePermissions(),
  useQuestions: () => mocks.useQuestions(),
}))

vi.mock('@/hooks/useRemoveMessage', () => ({
  useRefreshMessage: () => mocks.useRefreshMessage(),
}))

vi.mock('@/hooks/useSessionAgent', () => ({
  useSessionAgent: () => mocks.useSessionAgent(),
}))

interface MockSettingsReturn {
  preferences: {
    simpleChatMode: boolean
    showReasoning: boolean
  } | undefined
}

const setupSettings = (preferences: MockSettingsReturn['preferences']) => {
  mocks.useSettings.mockReturnValue({
    preferences,
    isLoading: false,
    updateSettings: vi.fn(),
    isUpdating: false,
  })
}

const createTextPart = (text: string, messageId: string) => ({
  type: 'text' as const,
  text,
  sessionID: 'test-session',
  messageID: messageId,
  id: 'part-1',
})

const createTaskToolPart = (description: string, sessionId: string | undefined, messageId: string) => ({
  type: 'tool' as const,
  tool: 'task',
  sessionID: 'test-session',
  messageID: messageId,
  id: 'part-2',
  callID: 'call-1',
  metadata: sessionId ? { sessionId } : undefined,
  state: {
    status: 'completed' as const,
    input: { description },
    output: 'done',
    title: 'Task',
    metadata: {},
    time: { start: Date.now(), end: Date.now() + 100 },
  },
})

const createSubtaskPart = (description: string, messageId: string) => ({
  type: 'subtask' as const,
  prompt: 'Please review this',
  description,
  agent: 'reviewer',
  sessionID: 'test-session',
  messageID: messageId,
  id: 'part-3',
})

const createStepFinishPart = (messageId: string) => ({
  type: 'step-finish' as const,
  sessionID: 'test-session',
  messageID: messageId,
  id: 'part-4',
  reason: 'stop',
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
})

const createReasoningPart = (text: string, messageId: string) => ({
  type: 'reasoning' as const,
  text,
  sessionID: 'test-session',
  messageID: messageId,
  id: 'part-5',
})

const createAssistantMessage = (
  id: string,
  parts: unknown[],
  modelID?: string
) => ({
  info: {
    id,
    role: 'assistant' as const,
    sessionID: 'test-session',
    parentID: 'parent-1',
    providerID: 'test-provider',
    mode: 'build',
    time: {
      created: Date.now(),
      completed: Date.now() + 100,
    },
    modelID: modelID || 'test-model',
  },
  parts,
})

const createUserMessage = (id: string, text: string, queueDelivery?: 'sent' | 'pending') => ({
  info: {
    id,
    role: 'user' as const,
    sessionID: 'test-session',
    agent: 'test-agent',
    model: 'test-model',
    time: {
      created: Date.now(),
    },
    ...(queueDelivery ? { queueDelivery } : {}),
  },
  parts: [createTextPart(text, id)],
})

describe('MessageThread', () => {
  beforeEach(() => {
    mocks.useSessionStatus.mockReturnValue({ type: 'idle' })
    mocks.useSessionTodos.mockReturnValue({ setTodos: vi.fn() })
    mocks.usePermissions.mockReturnValue({
      getForCallID: vi.fn(() => null),
    })
    mocks.useQuestions.mockReturnValue({
      getForCallID: vi.fn(() => null),
    })
    mocks.useRefreshMessage.mockReturnValue({
      isPending: false,
      mutate: vi.fn(),
    })
    mocks.useSessionAgent.mockReturnValue({ agent: 'test-agent' })
    useUIState.getState().setIsEditingMessage(false)
  })

  it('renders assistant message with only subtask part as standalone row without header', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: false,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [createSubtaskPart('Review changes', '2')]),
    ]

    const onChildSessionClick = vi.fn()

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
        onChildSessionClick={onChildSessionClick}
      />
    )

    expect(screen.getByText('Review changes')).toBeInTheDocument()
    expect(screen.getByText('sub-agent')).toBeInTheDocument()
    expect(screen.queryByText('test-model')).not.toBeInTheDocument()
  })

  it('renders assistant message with only task tool part as standalone row without header', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: false,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [createTaskToolPart('Do something', 'child-session', '2')]),
    ]

    const onChildSessionClick = vi.fn()

    const { container } = render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
        onChildSessionClick={onChildSessionClick}
      />
    )

    expect(screen.getByText('Do something')).toBeInTheDocument()
    expect(screen.getByText('sub-agent')).toBeInTheDocument()
    expect(screen.queryByText('test-model')).not.toBeInTheDocument()
    
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBeGreaterThan(0)
    fireEvent.click(buttons[buttons.length - 1])
    expect(onChildSessionClick).toHaveBeenCalledWith('child-session')
  })

  it('attaches suggestions to their source assistant message and reports selection', () => {
    setupSettings({ simpleChatMode: false, showReasoning: false })
    const onSuggestionSelect = vi.fn()
    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [createTextPart('Answer', '2')]),
      createAssistantMessage('3', [createTextPart('Later answer', '3')]),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
        suggestionsByAssistantId={new Map([['2', ['Ask for an example']]])}
        onSuggestionSelect={onSuggestionSelect}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ask for an example' }))
    expect(onSuggestionSelect).toHaveBeenCalledWith('Ask for an example')
    expect(screen.getByText('Answer').closest('.group')).toContainElement(screen.getByRole('button', { name: 'Ask for an example' }))
    expect(screen.getByText('Later answer').closest('.group')).not.toContainElement(screen.getByRole('button', { name: 'Ask for an example' }))
  })

  it('renders assistant task message with empty text and step finish as standalone row', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: false,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [
        createTextPart('   ', '2'),
        createTaskToolPart('Explore codebase structure', 'child-session', '2'),
        createStepFinishPart('2'),
      ]),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />
    )

    expect(screen.getByText('Explore codebase structure')).toBeInTheDocument()
    expect(screen.getByText('sub-agent')).toBeInTheDocument()
    expect(screen.queryByText('test-model')).not.toBeInTheDocument()
  })

  it('renders assistant task message with hidden reasoning as standalone row', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: false,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [
        createReasoningPart('I should use the explore agent', '2'),
        createTextPart('\n\n', '2'),
        createTaskToolPart('Explore codebase structure', 'child-session', '2'),
        createStepFinishPart('2'),
      ]),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />
    )

    expect(screen.getByText('Explore codebase structure')).toBeInTheDocument()
    expect(screen.getByText('sub-agent')).toBeInTheDocument()
    expect(screen.queryByText('test-model')).not.toBeInTheDocument()
    expect(screen.queryByText('I should use the explore agent')).not.toBeInTheDocument()
  })

  it('renders assistant task message with simple-chat reasoning setting as standalone row', () => {
    setupSettings({
      simpleChatMode: true,
      showReasoning: true,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [
        createReasoningPart('I should use the explore agent', '2'),
        createTextPart('\n\n', '2'),
        createTaskToolPart('Explore codebase structure', 'child-session', '2'),
        createStepFinishPart('2'),
      ]),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />
    )

    expect(screen.getByText('Explore codebase structure')).toBeInTheDocument()
    expect(screen.getByText('sub-agent')).toBeInTheDocument()
    expect(screen.queryByText('test-model')).not.toBeInTheDocument()
    expect(screen.queryByText('I should use the explore agent')).not.toBeInTheDocument()
  })

  it('renders assistant task message with visible reasoning as standalone row when no text exists', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: true,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [
        createReasoningPart('I should use the explore agent', '2'),
        createTextPart('\n\n', '2'),
        createTaskToolPart('Explore codebase structure', 'child-session', '2'),
        createStepFinishPart('2'),
      ]),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />
    )

    expect(screen.getByText('Explore codebase structure')).toBeInTheDocument()
    expect(screen.getByText('sub-agent')).toBeInTheDocument()
    expect(screen.queryByText('I should use the explore agent')).not.toBeInTheDocument()
    expect(screen.queryByText('test-model')).not.toBeInTheDocument()
  })

  it('renders assistant message with text normally with header', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: false,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [createTextPart('This is a response', '2')]),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />
    )

    expect(screen.getByText('This is a response')).toBeInTheDocument()
    expect(screen.queryByText('General Chat')).not.toBeInTheDocument()
    expect(screen.getByText('This is a response').closest('[class*="bg-transparent"]')).toBeInTheDocument()
  })

  it('renders assistant message with text and subtask normally with header', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: false,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [
        createTextPart('Here is the analysis', '2'),
        createSubtaskPart('Review changes', '2'),
      ]),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />
    )

    expect(screen.getByText('Here is the analysis')).toBeInTheDocument()
    expect(screen.getByText('Review changes')).toBeInTheDocument()
    expect(screen.queryByText('General Chat')).not.toBeInTheDocument()
  })

  it('renders user messages normally', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: false,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />
    )

    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('Hello').closest('.rounded-3xl')).toHaveClass('bg-primary', 'text-primary-foreground')
    expect(screen.getByTitle('Copy message')).toBeInTheDocument()
    expect(screen.queryByTitle('Download message')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Undo this message')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Edit message')).not.toBeInTheDocument()
  })

  it('shows session start date and time centered across message thread', () => {
    setupSettings({ simpleChatMode: false, showReasoning: false })
    const startedAt = new Date(2024, 0, 2, 15, 8).getTime()

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        sessionStartedAt={startedAt}
        messages={[createUserMessage('1', 'Hello')] as any}
      />,
    )

    const timestamp = screen.getByText(new Date(startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
    expect(timestamp.closest('.pointer-events-none')).toHaveClass('absolute', 'inset-x-0', 'text-center')
  })

  it('centers each sent timestamp across the full message container', () => {
    setupSettings({ simpleChatMode: false, showReasoning: false })
    const sentAt = new Date(2024, 0, 6, 15, 8).getTime()
    const message = createUserMessage('1', 'Hello')
    message.info.time.created = sentAt

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={[message] as any}
      />,
    )

    const timestamp = screen.getByText(formatSentTimestamp(sentAt))
    expect(timestamp).toHaveClass('w-full', 'text-center')
    expect(timestamp.parentElement).toHaveClass('relative', 'w-full')
  })

  it('formats sent timestamps by how recently they were sent', () => {
    const now = new Date(2026, 8, 26, 15, 0)
    const at = (daysAgo: number) => {
      const date = new Date(now)
      date.setDate(date.getDate() - daysAgo)
      date.setHours(11, 8, 0, 0)
      return date.getTime()
    }

    expect(formatSentTimestamp(at(0), now)).toBe('11:08 AM')
    expect(formatSentTimestamp(at(1), now)).toBe('Yesterday 11:08 AM')
    expect(formatSentTimestamp(at(3), now)).toBe('Wednesday 11:08 AM')
    expect(formatSentTimestamp(at(8), now)).toBe('Sep 18, 2026 11:08 AM')
  })

  it('keeps global editing state active when edit textarea blurs', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: false,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [createTextPart('This is a response', '2')]),
    ]

    const { unmount } = render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    const textarea = screen.getByPlaceholderText('Edit your message...')
    fireEvent.focus(textarea)
    expect(useUIState.getState().isEditingMessage).toBe(true)

    fireEvent.blur(textarea)
    expect(useUIState.getState().isEditingMessage).toBe(true)

    unmount()
    expect(useUIState.getState().isEditingMessage).toBe(false)
  })

  it('does not show Sending after the latest assistant response is complete', () => {
    setupSettings({ simpleChatMode: false, showReasoning: false })
    mocks.useSessionStatus.mockReturnValue({ type: 'busy' })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [createTextPart('This is a response', '2')]),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />,
    )

    expect(screen.queryByText('Sending...')).not.toBeInTheDocument()
  })

  it('shows Sending while a delivered user message awaits its assistant response', () => {
    setupSettings({ simpleChatMode: false, showReasoning: false })
    mocks.useSessionStatus.mockReturnValue({ type: 'busy' })

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={[createUserMessage('1', 'Hello')] as any}
      />,
    )

    expect(screen.getByText('Sending...')).toBeInTheDocument()
  })

  it.each([{ type: 'retry', attempt: 1, message: 'Retrying', next: Date.now() + 1000 }, { type: 'compact' }])(
    'does not show Sending for a $type session status',
    (status) => {
      setupSettings({ simpleChatMode: false, showReasoning: false })
      mocks.useSessionStatus.mockReturnValue(status)

      render(
        <MessageThread
          apiUrl="http://localhost:5551"
          sessionID="test-session"
          messages={[createUserMessage('1', 'Hello')] as any}
        />,
      )

      expect(screen.queryByText('Sending...')).not.toBeInTheDocument()
    },
  )

  it('does not show Sending for an undelivered queued user message', () => {
    setupSettings({ simpleChatMode: false, showReasoning: false })
    mocks.useSessionStatus.mockReturnValue({ type: 'busy' })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [createTextPart('This is a response', '2')]),
      createUserMessage('3', 'Follow up', 'pending'),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />,
    )

    expect(screen.queryByText('Sending...')).not.toBeInTheDocument()
  })

  it('does not label the first message as queued before any assistant response', () => {
    setupSettings({ simpleChatMode: false, showReasoning: false })

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={[createUserMessage('1', 'First prompt')] as any}
      />,
    )

    expect(screen.queryByText('QUEUED')).not.toBeInTheDocument()
  })

  it('resends an edited prompt after the edit textarea blurs', () => {
    setupSettings({
      simpleChatMode: false,
      showReasoning: false,
    })
    const mutate = vi.fn()
    mocks.useRefreshMessage.mockReturnValue({
      isPending: false,
      mutate,
    })

    const messages = [
      createUserMessage('1', 'Hello'),
      createAssistantMessage('2', [createTextPart('This is a response', '2')]),
    ]

    render(
      <MessageThread
        apiUrl="http://localhost:5551"
        sessionID="test-session"
        messages={messages as any}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    const textarea = screen.getByPlaceholderText('Edit your message...')
    fireEvent.change(textarea, { target: { value: 'Updated prompt' } })
    fireEvent.blur(textarea)
    fireEvent.click(screen.getByRole('button', { name: /resend/i }))

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMessageID: '2',
        userMessageContent: 'Updated prompt',
      }),
      expect.any(Object),
    )
  })
})
