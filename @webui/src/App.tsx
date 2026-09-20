import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider, Outlet, useNavigate, useLocation, Navigate, useParams } from 'react-router-dom'
import { useEffect, useRef, useCallback, useState } from 'react'
import { Toaster } from 'sonner'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { Register } from './pages/Register'
import { Setup } from './pages/Setup'
import { Projects } from './pages/Projects'
import { ProjectDetail } from './pages/ProjectDetail'
import { ProjectChanges } from './pages/ProjectChanges'
import { Automations } from './pages/Automations'
import { SessionDetail } from './pages/SessionDetail'
import { History } from './pages/History'
import { Agents } from './pages/Agents'
import { AgentChat } from './pages/AgentChat'
import { NewSession } from './pages/NewSession'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { loginLoader, registerLoader, setupLoader } from './lib/auth-loaders'

import { MobileTabBar } from '@/components/navigation/MobileTabBar'
import { MobileSheetHost } from '@/components/navigation/MobileSheetHost'
import { DesktopSidebar } from '@/components/navigation/DesktopSidebar'
import { useTheme } from './hooks/useTheme'
import { useSettingsDialog } from './hooks/useSettingsDialog'
import { useRightEdgeSwipe, useSwipeBack } from './hooks/useMobile'
import { useMobileTabBar } from '@/hooks/useMobileTabBar'
import { TTSProvider } from './contexts/TTSContext'
import { AuthProvider } from './contexts/AuthContext'
import { EventProvider } from '@/contexts/EventContext'
import { SwipeNavigationProvider, useSwipeNavigation } from '@/contexts/SwipeNavigationContext'
import { getSwipeBackTarget } from '@/lib/navigation'
import { useAuth } from '@/hooks/useAuth'
import { useServerHealth } from '@/hooks/useServerHealth'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { CommandPalette } from '@/components/navigation/CommandPalette'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1000 * 10, refetchOnWindowFocus: true },
  },
})

function RepoRedirect() {
  const { id, sessionId } = useParams<{ id: string; sessionId: string }>()
  if (sessionId && id) return <Navigate to={`/projects/${id}/sessions/${sessionId}`} replace />
  if (id) return <Navigate to={`/projects/${id}`} replace />
  return <Navigate to="/projects" replace />
}

function HealthMonitor() {
  const { isAuthenticated } = useAuth()
  useServerHealth(isAuthenticated)
  return null
}

function SettingsRoute() {
  const navigate = useNavigate()
  const { isOpen, open } = useSettingsDialog()
  const didOpen = useRef(false)

  useEffect(() => {
    if (isOpen) {
      didOpen.current = true
      return
    }
    if (didOpen.current) {
      navigate('/home', { replace: true })
      return
    }
    open()
  }, [isOpen, open, navigate])

  return null
}

function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const rootRef = useRef<HTMLDivElement>(null)
  const { openSheet, open } = useMobileTabBar()
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  useTheme()
  useKeyboardShortcuts({
    openCommandPalette: () => setCommandPaletteOpen(true),
    newSession: () => navigate('/new'),
    openSessions: () => navigate('/history'),
  })
  const swipeNav = useSwipeNavigation()

  const getRouteSwipeBackTarget = useCallback(
    () => getSwipeBackTarget(location.pathname, location.search),
    [location.pathname, location.search],
  )
  const canSwipeBack = useCallback(
    () => !swipeNav?.isSuspended() && getRouteSwipeBackTarget() !== null,
    [swipeNav, getRouteSwipeBackTarget],
  )
  const handleSwipeBack = useCallback(() => {
    const target = getRouteSwipeBackTarget()
    if (target) navigate(target)
  }, [getRouteSwipeBackTarget, navigate])
  const { bind: bindRouteSwipe } = useSwipeBack(() => {}, {
    enabled: true,
    suspendsRouteSwipe: false,
    canBack: canSwipeBack,
    onBack: handleSwipeBack,
  })
  const { bind: bindMoreSwipe } = useRightEdgeSwipe(
    () => open('more'),
    { enabled: /^\/projects\/[^/]+\/sessions\/[^/]+$/.test(location.pathname) && !openSheet, edgeWidth: 32, threshold: 60 },
  )

  useEffect(() => {
    const cleanup = bindRouteSwipe(rootRef.current)
    return () => cleanup?.()
  }, [bindRouteSwipe])
  useEffect(() => {
    const cleanup = bindMoreSwipe(rootRef.current)
    return () => cleanup?.()
  }, [bindMoreSwipe])
  useEffect(() => {
    const channel = new BroadcastChannel('notification-click')
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { url?: string } | null | undefined
      if (typeof data?.url === 'string') navigate(data.url)
    }
    return () => channel.close()
  }, [navigate])

  return (
    <EventProvider>
      <div ref={rootRef} className="flex h-dvh w-full min-w-0">
        <DesktopSidebar />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col"><Outlet /></div>
      </div>
      <MobileTabBar />
      <MobileSheetHost />
      <HealthMonitor />
      <SettingsDialog />
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      <Toaster position="bottom-right" expand={false} richColors closeButton duration={2500} />
    </EventProvider>
  )
}

function AuthRoot() {
  const { isAuthenticated, isLoading } = useAuth()
  const location = useLocation()
  if (isLoading) return <div className="h-dvh flex items-center justify-center">Loading…</div>
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  return <AppShell />
}

function RouterRoot() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}

const router = createBrowserRouter([
  {
    element: <RouterRoot />,
    children: [
      { path: '/login', element: <Login />, loader: loginLoader },
      { path: '/register', element: <Register />, loader: registerLoader },
      { path: '/setup', element: <Setup />, loader: setupLoader },
      {
        element: <AuthRoot />,
        children: [
          { path: '/', element: <Home /> },
          { path: '/home', element: <Home /> },
          { path: '/agents', element: <Agents /> },
          { path: '/agents/:agentName', element: <AgentChat /> },
          { path: '/new', element: <NewSession /> },
          { path: '/new/:agentName', element: <NewSession /> },
          { path: '/new/:projectName/:agentName', element: <NewSession /> },
          { path: '/projects', element: <Projects /> },
          { path: '/projects/:id', element: <ProjectDetail /> },
          { path: '/projects/:id/changes', element: <ProjectChanges /> },
          { path: '/projects/:id/automations', element: <Automations /> },
          { path: '/projects/:id/sessions/:sessionId', element: <SessionDetail /> },
          { path: '/repos/:id/sessions/:sessionId', element: <RepoRedirect /> },
          { path: '/repos/:id/automations', element: <Automations /> },
          { path: '/repos/:id', element: <RepoRedirect /> },
          { path: '/repos', element: <RepoRedirect /> },
          { path: '/history', element: <History /> },
          { path: '/settings', element: <SettingsRoute /> },
        ],
      },
    ],
  },
])

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TTSProvider>
        <SwipeNavigationProvider>
          <RouterProvider router={router} />
        </SwipeNavigationProvider>
      </TTSProvider>
    </QueryClientProvider>
  )
}

export default App
