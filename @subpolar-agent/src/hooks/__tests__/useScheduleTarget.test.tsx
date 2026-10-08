import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAutomationTarget } from '../useAutomationTarget'
import type { GeneralChatStatus } from '@subpolar/shared/types'

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getGeneralChatStatus: vi.fn(),
}))

vi.mock('@/api/projects', () => ({
  getProject: mocks.getProject,
  getGeneralChatStatus: mocks.getGeneralChatStatus,
}))

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

describe('useAutomationTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('repoId === 0 (general chat)', () => {
    it('returns general chat automation target with correct properties', async () => {
      const mockStatus: GeneralChatStatus = {
        repoId: 0,
        directory: '/abs/assistant',
        relativePath: 'repos/assistant',
        files: {
          agentsMd: { path: '', exists: false, created: false },
          opencodeJson: { path: '', exists: false, created: false },
        },
        agents: [],
        automationsSkill: { path: '', exists: false, created: false },
      }

      mocks.getGeneralChatStatus.mockResolvedValue(mockStatus)

      const { result } = renderHook(() => useAutomationTarget(0), { wrapper: createWrapper() })

      await waitFor(() => {
        expect(result.current.automationTarget).toBeDefined()
      })

      expect(result.current.automationTarget?.kind).toBe('project')
      expect(result.current.automationTarget?.fullPath).toBe('/abs/assistant')
      expect(result.current.automationTarget?.projectId).toBe(0)
      expect(result.current.automationTarget?.backHref).toBe('/projects/0')
      expect(result.current.isLoading).toBe(false)
      expect(result.current.isError).toBe(false)
    })

    it('does not call getRepo for general chat', async () => {
      mocks.getGeneralChatStatus.mockResolvedValue({
        directory: '/abs/assistant',
        relativePath: 'repos/assistant',
        files: { agentsMd: { path: '', exists: false, created: false }, opencodeJson: { path: '', exists: false, created: false } },
        agents: [],
        automationsSkill: { path: '', exists: false, created: false },
        repoId: 0,
      })

      renderHook(() => useAutomationTarget(0), { wrapper: createWrapper() })

      await vi.waitFor(() => {
        expect(mocks.getProject).not.toHaveBeenCalled()
      })
    })
  })

  describe('repoId === 5 (real project)', () => {
    it('returns project automation target with correct properties', async () => {
      const mockProject = {
        id: 5,
        name: 'my-project',
        directory: 'repos/my-project',
        fullPath: '/abs/repos/my-project',
        status: 'ready' as const,
        createdAt: 0,
        updatedAt: 0,
      }

      mocks.getProject.mockResolvedValue(mockProject)

      const { result } = renderHook(() => useAutomationTarget(5), { wrapper: createWrapper() })

      await waitFor(() => {
        expect(result.current.automationTarget).toBeDefined()
      })

      expect(result.current.automationTarget?.kind).toBe('project')
      expect(result.current.automationTarget?.projectId).toBe(5)
      expect(result.current.automationTarget?.fullPath).toBe('/abs/repos/my-project')
      expect(result.current.automationTarget?.backHref).toBe('/projects/5')
    })

    it('does not call getGeneralChatStatus for project', async () => {
      const mockProject = {
        id: 5,
        name: 'my-project',
        directory: 'repos/my-project',
        fullPath: '/abs/repos/my-project',
        status: 'ready' as const,
        createdAt: 0,
        updatedAt: 0,
      }

      mocks.getProject.mockResolvedValue(mockProject)

      renderHook(() => useAutomationTarget(5), { wrapper: createWrapper() })

      await vi.waitFor(() => {
        expect(mocks.getGeneralChatStatus).not.toHaveBeenCalled()
      })
    })
  })

  describe('repoId === undefined', () => {
    it('returns undefined automation target', () => {
      const { result } = renderHook(() => useAutomationTarget(undefined), { wrapper: createWrapper() })

      expect(result.current.automationTarget).toBeUndefined()
      expect(result.current.isLoading).toBe(false)
    })
  })
})
