
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider, Outlet, useNavigate, useLocation, Navigate, useParams } from 'react-router-dom'
import { useEffect, useRef, useCallback } from 'react'
import { Toaster } from 'sonner'
import { Home } from './pages/Home'
import { Projects } from './pages/Projects'
import { ProjectDetail } from './pages/ProjectDetail'
import { SessionDetail } from './pages/SessionDetail'
import { History } from './pages/History'
import { Agents } from './pages/Agents'
import { AgentChat } from './pages/AgentChat'

import { MobileTabBar } from '@/components/navigation/MobileTabBar'
import { MobileSheetHost } from '@/components/navigation/MobileSheetHost'
import { DesktopSidebar } from '@/components/navigation/DesktopSidebar'
import { useTheme } from './hooks/useTheme'
import { useRightEdgeSwipe, useSwipeBack } from './hooks/useMobile'
import { useMobileTabBar } from '@/hooks/useMobileTabBar'
import { TTSProvider } from './contexts/TTSContext'
import { AuthProvider } from './contexts/AuthContext'
import { EventProvider } from '@/contexts/EventContext'
import { SwipeNavigationProvider, useSwipeNavigation } from '@/contexts/SwipeNavigationContext'
import { getSwipeBackTarget } from '@/lib/navigation'
import { useAuth } from '@/hooks/useAuth'
import { useServerHealth } from '@/hooks/useServerHealth'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 10,
      refetchOnWindowFocus: true,
    },
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

function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const rootRef = useRef<HTMLDivElement>(null)
  const { openSheet, open } = useMobileTabBar()
  useTheme()

  const swipeNav = useSwipeNavigation()

  const getRouteSwipeBackTarget = useCallback(
    () => getSwipeBackTarget(location.pathname, location.search),
    [location.pathname, location.search]
  )

  const canSwipeBack = useCallback(
    () => !swipeNav?.isSuspended() && getRouteSwipeBackTarget() !== null,
    [swipeNav, getRouteSwipeBackTarget]
  )

  const handleSwipeBack = useCallback(() => {
    const target = getRouteSwipeBackTarget()
    if (target) navigate(target)
  }, [getRouteSwipeBackTarget, navigate])

  const { bind: bindRouteSwipe } = useSwipeBack(
    () => {},
    {
      enabled: true,
      suspendsRouteSwipe: false,
      canBack: canSwipeBack,
      onBack: handleSwipeBack,
    }
  )

  const canOpenMoreWithSwipe = () => {
    return /^\/projects\/[^/]+\/sessions\/[^/]+$/.test(location.pathname) && !openSheet
  }

  const { bind: bindMoreSwipe } = useRightEdgeSwipe(
    () => open('more'),
    {
      enabled: canOpenMoreWithSwipe(),
      edgeWidth: 32,
      threshold: 60,
    }
  )

  useEffect(() => {
    const cleanup = bindRouteSwipe(rootRef.current)
    return () => {
      cleanup?.()
    }
  }, [bindRouteSwipe])

  useEffect(() => {
    const cleanup = bindMoreSwipe(rootRef.current)
    return () => {
      cleanup?.()
    }
  }, [bindMoreSwipe])

  useEffect(() => {
    const channel = new BroadcastChannel('notification-click')
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { url?: string } | null | undefined
      if (typeof data?.url === 'string') {
        navigate(data.url)
      }
    }
    return () => channel.close()
  }, [navigate])

  return (
    <AuthProvider>
      <EventProvider>
        <div ref={rootRef} className="flex h-dvh w-full min-w-0">
          <DesktopSidebar />
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <Outlet />
          </div>
        </div>
        <MobileTabBar />
        <MobileSheetHost />
         <HealthMonitor />
        <Toaster
          position="bottom-right"
          expand={false}
          richColors
          closeButton
          duration={2500}
        />
      </EventProvider>
    </AuthProvider>
  )
}

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      {
        path: '/',
        element: <Home />,
      },
      {
        path: '/home',
        element: <Home />,
      },
      {
        path: '/agents',
        element: <Agents />,
      },
      {
        path: '/agents/:agentName',
        element: <AgentChat />,
      },
      {
        path: '/projects',
        element: <Projects />,
      },
      {
        path: '/projects/:id',
        element: <ProjectDetail />,
      },
      {
        path: '/projects/:id/sessions/:sessionId',
        element: <SessionDetail />,
      },
      {
        path: '/repos/:id/sessions/:sessionId',
        element: <RepoRedirect />,
      },
      {
        path: '/repos/:id/automations',
        element: <RepoRedirect />,
      },
      {
        path: '/repos/:id',
        element: <RepoRedirect />,
      },
      {
        path: '/repos',
        element: <RepoRedirect />,
      },
      {
        path: '/history',
        element: <History />,
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
