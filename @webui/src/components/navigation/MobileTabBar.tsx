import { memo, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FolderKanban, Menu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMobile } from '@/hooks/useMobile'
import { useMobileTabBar } from '@/hooks/useMobileTabBar'

interface TabDef {
  key: string
  label: string
  icon: React.ElementType
  onClick: () => void
  active: boolean
  badge?: boolean
}

interface GlobalTabsArgs {
  pathname: string
  openSheet: ReturnType<typeof useMobileTabBar>['openSheet']
  open: ReturnType<typeof useMobileTabBar>['open']
  navigate: ReturnType<typeof useNavigate>
}

type TabBarMode = 'hidden' | 'global'

interface MobileTabRouteState {
  mode: TabBarMode
  isInsideProject: boolean
  projectId: string | null
}

function getMobileTabRouteState(pathname: string): MobileTabRouteState {
  const projectMatch = pathname.match(/^\/projects\/(\d+)(?:\/([^/]+))?/)
  const projectId = projectMatch?.[1] ?? null
  const projectSection = projectMatch?.[2]

  if (pathname === '/') {
    return { mode: 'global', isInsideProject: false, projectId: null }
  }

  if (!projectId) {
    return { mode: 'hidden', isInsideProject: false, projectId: null }
  }

  switch (projectSection) {
    case undefined:
      return { mode: 'global', isInsideProject: true, projectId }
    default:
      return { mode: 'hidden', isInsideProject: false, projectId }
  }
}

function buildGlobalTabs({ pathname, openSheet, open, navigate }: GlobalTabsArgs): TabDef[] {
  return [
    {
      key: 'projects',
      label: 'Projects',
      icon: FolderKanban,
      onClick: () => navigate('/projects'),
      active: pathname === '/projects' || (pathname === '/' && !openSheet),
    },
    {
      key: 'more',
      label: 'More',
      icon: Menu,
      onClick: () => open('more'),
      active: openSheet === 'more',
    },
  ]
}

interface TabBarRowProps {
  tabs: TabDef[]
}

const TabBarRow = memo(function TabBarRow({ tabs }: TabBarRowProps) {
  return (
    <div className="fixed bottom-0 inset-x-0 z-40 flex border-t border-border bg-card/90 backdrop-blur-sm pb-safe">
      {tabs.map((tab) => {
        const Icon = tab.icon
        return (
          <button
            key={tab.key}
            type="button"
            className={cn(
              'relative flex-1 flex flex-col items-center justify-center gap-1 px-2 py-2 text-xs font-medium border-b-2 transition-colors',
              tab.active
                ? 'text-primary border-primary'
                : 'text-muted-foreground border-transparent hover:text-foreground',
            )}
            onClick={tab.onClick}
          >
            <div className="relative">
              <Icon className="w-5 h-5" />
              {tab.badge && (
                <span className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-orange-500 ring-2 ring-card animate-pulse" />
              )}
            </div>
            <span className="leading-none">{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
})

export const MobileTabBar = memo(function MobileTabBar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { openSheet, open } = useMobileTabBar()
  const isMobile = useMobile()
  const routeState = useMemo(() => getMobileTabRouteState(pathname), [pathname])

  const tabs = useMemo<TabDef[]>(
    () => buildGlobalTabs({
        pathname,
        openSheet,
        open,
        navigate,
      }),
    [
      routeState,
      pathname,
      openSheet,
      open,
      navigate,
    ],
  )

  if (!isMobile) return null
  if (routeState.mode === 'hidden') return null

  return <TabBarRow tabs={tabs} />
})
