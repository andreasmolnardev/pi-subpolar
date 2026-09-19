import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCommandHandler } from '../useCommandHandler'

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  summarizeSession: vi.fn(),
  navigate: vi.fn(),
  setStatus: vi.fn(),
}))

vi.mock('@/api/subpolar', () => ({
  createSubpolarClient: vi.fn().mockImplementation(() => ({
    sendCommand: mocks.sendCommand,
    summarizeSession: mocks.summarizeSession,
  })),
}))

vi.mock('@/lib/toast', () => ({
  showToast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
  },
}))

vi.mock('@/hooks/useModelSelection', () => ({
  useModelSelection: vi.fn(() => ({
    model: { providerID: 'test-provider', modelID: 'test-model' },
    modelString: 'test-provider/test-model',
  })),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(() => mocks.navigate),
}))

vi.mock('@/stores/sessionStatusStore', () => ({
  useSessionStatus: vi.fn((selector) => selector({ setStatus: mocks.setStatus })),
}))

describe('useCommandHandler', () => {
  const baseProps = {
    apiUrl: 'http://localhost:5551',
    sessionID: 'test-session-id',
    directory: '/test/dir',
    currentAgent: 'test-agent',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('themes command sends command', async () => {
    mocks.sendCommand.mockResolvedValue({ info: { id: 'asm_1' }, parts: [] })

    const { result } = renderHook(() => useCommandHandler(baseProps))
    const themesCommand = { name: 'themes' as const }

    await result.current.executeCommand(themesCommand, '')

    expect(mocks.sendCommand).toHaveBeenCalledWith('test-session-id', {
      command: 'themes',
      arguments: '',
      agent: 'test-agent',
      model: 'test-provider/test-model',
    })
  })

  it('compact command summarizes session', async () => {
    mocks.summarizeSession.mockResolvedValue(undefined)

    const { result } = renderHook(() => useCommandHandler(baseProps))
    const compactCommand = { name: 'compact' as const }

    await result.current.executeCommand(compactCommand, '')

    expect(mocks.summarizeSession).toHaveBeenCalledWith(
      'test-session-id',
      'test-provider',
      'test-model'
    )
  })

  it('unknown command sends command', async () => {
    mocks.sendCommand.mockResolvedValue({ info: { id: 'asm_1' }, parts: [] })

    const { result } = renderHook(() => useCommandHandler(baseProps))
    const unknownCommand = { name: 'myskill' as const }

    await result.current.executeCommand(unknownCommand, '')

    expect(mocks.sendCommand).toHaveBeenCalledWith('test-session-id', {
      command: 'myskill',
      arguments: '',
      agent: 'test-agent',
      model: 'test-provider/test-model',
    })
  })

  it('sessions command opens sessions dialog without sending command', async () => {
    const onShowSessionsDialog = vi.fn()
    const { result } = renderHook(() =>
      useCommandHandler({ ...baseProps, onShowSessionsDialog })
    )
    const sessionsCommand = { name: 'sessions' as const }

    await result.current.executeCommand(sessionsCommand, '')

    expect(mocks.sendCommand).not.toHaveBeenCalled()
    expect(onShowSessionsDialog).toHaveBeenCalled()
  })

  it('new command navigates to the canonical route with encoded context', async () => {
    const { result } = renderHook(() => useCommandHandler({
      ...baseProps,
      projectName: 'My Project',
      currentAgent: 'agent/one',
    }))

    await result.current.executeCommand({ name: 'new' as const }, '')

    expect(mocks.navigate).toHaveBeenCalledWith('/new/My%20Project/agent%2Fone')
    expect(mocks.sendCommand).not.toHaveBeenCalled()
  })

  it('new command uses the general route without session context', async () => {
    const { result } = renderHook(() => useCommandHandler({
      ...baseProps,
      currentAgent: undefined,
    }))

    await result.current.executeCommand({ name: 'new' as const }, '')

    expect(mocks.navigate).toHaveBeenCalledWith('/new')
  })

  it('new command maps a single agent argument to the canonical route', async () => {
    const { result } = renderHook(() => useCommandHandler(baseProps))

    await result.current.executeCommand({ name: 'new' as const }, 'agent/one')

    expect(mocks.navigate).toHaveBeenCalledWith('/new/agent%2Fone')
  })

  it('new command maps explicit agent and project arguments to canonical routes', async () => {
    const { result } = renderHook(() => useCommandHandler(baseProps))

    await result.current.executeCommand({ name: 'new' as const }, '"My Project" agent/one')

    expect(mocks.navigate).toHaveBeenCalledWith('/new/My%20Project/agent%2Fone')
  })

  it('rejects invalid new-session arguments without navigating', async () => {
    const { result } = renderHook(() => useCommandHandler(baseProps))

    await result.current.executeCommand({ name: 'new' as const }, 'project agent extra')

    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.sendCommand).not.toHaveBeenCalled()
  })
})
