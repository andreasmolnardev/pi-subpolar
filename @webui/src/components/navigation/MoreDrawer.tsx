import { useNavigate, useLocation, useParams } from 'react-router-dom'
import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight, Command as CommandIcon, FileText, X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useServerHealth } from '@/hooks/useServerHealth'
import { useCommands } from '@/hooks/useCommands'
import { useUrlParams } from '@/hooks/useUrlParams'
import { useUIState } from '@/stores/uiStateStore'
import { SUBPOLAR_API_BASE_URL } from '@/config'
import { SideDrawer, SideDrawerContent } from '@/components/ui/side-drawer'
import { FileBrowserSheet } from '@/components/file-browser/FileBrowserSheet'
import { buildMoreItems } from './moreDrawerItems'
import { useSwipeBack } from '@/hooks/useMobile'

import { getPathWithReturnTo } from '@/lib/navigation'
import type { components } from '@/api/opencode-types'

type CommandType = components['schemas']['Command']

interface MoreDrawerProps {
  isOpen: boolean
  onClose: () => void
}

export function MoreDrawer({ isOpen, onClose }: MoreDrawerProps) {
  const navigate = useNavigate()
  const location = useLocation()
  useParams<{ id: string }>()
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [mentionFileBrowserOpen, setMentionFileBrowserOpen] = useState(false)
  const swipeRef = useRef<HTMLDivElement>(null)
  const { bind } = useSwipeBack(onClose, { enabled: isOpen, suspendsRouteSwipe: true })
  const { updateParams } = useUrlParams()
  const { logout } = useAuth()
  const { data: health } = useServerHealth()
  const isSessionDetail = /^\/projects\/\d+\/sessions\/[^/]+$/.test(location.pathname)
  const { filterCommands } = useCommands(isSessionDetail ? SUBPOLAR_API_BASE_URL : null)
  const activePromptFileBasePath = useUIState((state) => state.activePromptFileBasePath)
  const selectPromptCommand = useUIState((state) => state.selectPromptCommand)
  const selectPromptFile = useUIState((state) => state.selectPromptFile)

  useEffect(() => {
    if (isOpen && swipeRef.current) {
      const cleanup = bind(swipeRef.current)
      return cleanup
    }
  }, [isOpen, bind])



  const handleSettingsClick = () => {
    updateParams((p) => {
      p.delete('mobileTab')
      p.set('settings', 'open')
      p.set('settingsTab', 'account')
    }, 'replace')
  }

  const handleLogoutClick = async () => {
    try {
      await logout()
    } finally {
      onClose()
    }
  }

  const handleItemClick = (item: ReturnType<typeof buildMoreItems>[0]) => {
    if (item.to) {
      const to = item.key === 'automations'
        ? getPathWithReturnTo(item.to, `${location.pathname}${location.search}`)
        : item.to
      navigate(to)
    } else if (item.dialog) {
      updateParams((p) => {
        p.set('dialog', item.dialog!)
        p.delete('mobileTab')
      }, 'replace')
    }
  }

  const handleCommandClick = (command: CommandType) => {
    selectPromptCommand(command)
    onClose()
  }

  const getPromptFilePath = (path: string) => {
    if (!activePromptFileBasePath) return path

    const normalizedPath = path.replace(/^\.\//, '')
    const normalizedBasePath = activePromptFileBasePath.replace(/^\.\//, '').replace(/\/+$/, '')
    const basePrefix = `${normalizedBasePath}/`

    return normalizedPath.startsWith(basePrefix)
      ? normalizedPath.slice(basePrefix.length)
      : normalizedPath
  }

  const handleFileClick = (path: string) => {
    selectPromptFile(getPromptFilePath(path))
    setMentionFileBrowserOpen(false)
    onClose()
  }

  const items = buildMoreItems(location.pathname)
  const commands = filterCommands('')

  const runtimeVersion = health?.opencodeVersion
  const managerVersion = health?.opencodeManagerVersion
  const versionLabel = [
    runtimeVersion ? `v${runtimeVersion}` : null,
    managerVersion ? `Manager v${managerVersion}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <SideDrawer isOpen={isOpen} onClose={onClose} side="right" ariaLabel="More" widthClass="w-screen sm:w-[min(90vw,420px)]">
      <div ref={swipeRef} className="flex flex-col flex-1 min-h-0">
        <div className="flex flex-col flex-shrink-0 border-b border-border bg-background px-4 py-1.5">
          <div className="flex items-center justify-between gap-3 mb-2">
            {versionLabel && (
              <span className="truncate text-xs leading-tight text-muted-foreground">{versionLabel}</span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-sm p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

        </div>
        <SideDrawerContent className="flex flex-col gap-1">
          {isSessionDetail && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setCommandsOpen((open) => !open)}
                className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors text-left w-full"
                aria-expanded={commandsOpen}
              >
                <CommandIcon className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium text-foreground flex-1">Commands</span>
                {commandsOpen ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
              {commandsOpen && (
                <div className="-mx-4 max-h-64 overflow-y-auto border-y border-border bg-muted/30 p-1 sm:mx-0 sm:rounded-lg sm:border">
                  {commands.map((command) => (
                    <button
                      key={command.name}
                      type="button"
                      onClick={() => handleCommandClick(command)}
                      className="flex w-full min-w-0 items-start gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent"
                    >
                      <span className="font-mono text-sm font-medium text-blue-600 dark:text-blue-400">{command.name}</span>
                      {command.description && (
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{command.description}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setMentionFileBrowserOpen(true)}
                className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors text-left w-full"
              >
                <FileText className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium text-foreground flex-1">Mention File</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          )}
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                if (item.key === 'settings') {
                  handleSettingsClick()
                } else if (item.key === 'logout') {
                  handleLogoutClick()
                } else {
                  handleItemClick(item)
                }
              }}
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors text-left w-full"
            >
              <item.icon className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium text-foreground">{item.label}</span>
            </button>
          ))}
        </SideDrawerContent>
      </div>
      <FileBrowserSheet
        isOpen={mentionFileBrowserOpen}
        onClose={() => setMentionFileBrowserOpen(false)}
        basePath={activePromptFileBasePath ?? ''}
        onFileSelect={(file) => handleFileClick(file.path)}
      />
    </SideDrawer>
  )
}
