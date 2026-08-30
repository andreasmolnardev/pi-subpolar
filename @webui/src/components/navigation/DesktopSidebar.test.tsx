import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DesktopSidebar } from './DesktopSidebar'
import { getSidebarProjectRoute } from '@/lib/projectNavigation'
import * as useDesktopModule from '@/hooks/useDesktop'
import * as useSidebarCollapsedModule from '@/hooks/useSidebarCollapsed'
import * as useAuthModule from '@/hooks/useAuth'

vi.mock('@/hooks/useDesktop')
vi.mock('@/hooks/useSidebarCollapsed')
vi.mock('@/hooks/useAuth')

vi.mock('@/api/projects', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
  hasProjectId: (project: { id: unknown }) => typeof project.id === 'number' && Number.isFinite(project.id),
  createProject: vi.fn(),
}))

vi.mock('@/api/settings', () => ({
  settingsApi: {
    getPiConfigs: vi.fn().mockResolvedValue({ configs: [], defaultConfig: null }),
  },
}))

function createWrapper(initialEntries?: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('DesktopSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when user is not authenticated', () => {
    vi.spyOn(useDesktopModule, 'useDesktop').mockReturnValue(false)
    vi.spyOn(useSidebarCollapsedModule, 'useSidebarCollapsed').mockReturnValue([false, vi.fn()])
    vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      user: null,
    } as any)

    const { container } = render(<DesktopSidebar />, { wrapper: createWrapper(['/']) })

    expect(container.firstChild).toBeNull()
  })

  it('returns null when auth state is loading', () => {
    vi.spyOn(useDesktopModule, 'useDesktop').mockReturnValue(false)
    vi.spyOn(useSidebarCollapsedModule, 'useSidebarCollapsed').mockReturnValue([false, vi.fn()])
    vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: true,
      user: null,
    } as any)

    const { container } = render(<DesktopSidebar />, { wrapper: createWrapper(['/']) })

    expect(container.firstChild).toBeNull()
  })

  it('returns null when not desktop', () => {
    vi.spyOn(useDesktopModule, 'useDesktop').mockReturnValue(false)
    vi.spyOn(useSidebarCollapsedModule, 'useSidebarCollapsed').mockReturnValue([false, vi.fn()])
    vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: null,
    } as any)

    const { container } = render(<DesktopSidebar />, { wrapper: createWrapper(['/']) })

    expect(container.firstChild).toBeNull()
  })

  it('renders brand name', () => {
    vi.spyOn(useDesktopModule, 'useDesktop').mockReturnValue(true)
    vi.spyOn(useSidebarCollapsedModule, 'useSidebarCollapsed').mockReturnValue([false, vi.fn()])
    vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: null,
    } as any)

    render(<DesktopSidebar />, { wrapper: createWrapper(['/']) })

    expect(screen.getByText('subpolar')).toBeInTheDocument()
  })

  it('renders Home, Agents, and Projects sections', () => {
    vi.spyOn(useDesktopModule, 'useDesktop').mockReturnValue(true)
    vi.spyOn(useSidebarCollapsedModule, 'useSidebarCollapsed').mockReturnValue([false, vi.fn()])
    vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: null,
    } as any)

    render(<DesktopSidebar />, { wrapper: createWrapper(['/']) })

    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Projects')).toBeInTheDocument()
  })

  it('shows General Chat sub-item under Agents', () => {
    vi.spyOn(useDesktopModule, 'useDesktop').mockReturnValue(true)
    vi.spyOn(useSidebarCollapsedModule, 'useSidebarCollapsed').mockReturnValue([false, vi.fn()])
    vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: null,
    } as any)

    render(<DesktopSidebar />, { wrapper: createWrapper(['/']) })

    expect(screen.getByText('General Chat')).toBeInTheDocument()
  })

  it('shows user name and email in profile section', () => {
    vi.spyOn(useDesktopModule, 'useDesktop').mockReturnValue(true)
    vi.spyOn(useSidebarCollapsedModule, 'useSidebarCollapsed').mockReturnValue([false, vi.fn()])
    vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { name: 'Test User', email: 'test@example.com', image: null },
    } as any)

    render(<DesktopSidebar />, { wrapper: createWrapper(['/']) })

    expect(screen.getByText('Test User')).toBeInTheDocument()
    expect(screen.getByText('test@example.com')).toBeInTheDocument()
  })

  it('shows user initial when no image', () => {
    vi.spyOn(useDesktopModule, 'useDesktop').mockReturnValue(true)
    vi.spyOn(useSidebarCollapsedModule, 'useSidebarCollapsed').mockReturnValue([false, vi.fn()])
    vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { name: 'Alice', email: 'alice@example.com', image: null },
    } as any)

    render(<DesktopSidebar />, { wrapper: createWrapper(['/']) })

    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('does not build a project route for null project IDs', () => {
    const route = getSidebarProjectRoute('null', [
      {
        id: null,
        name: 'Broken Project',
        directory: 'broken-project',
        fullPath: '/tmp/broken-project',
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    expect(route).toBeNull()
  })

  it('builds project routes only from finite project IDs', () => {
    const route = getSidebarProjectRoute('7', [
      {
        id: 7,
        name: 'Real Project',
        directory: 'real-project',
        fullPath: '/tmp/real-project',
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    expect(route).toBe('/projects/7')
  })
})
