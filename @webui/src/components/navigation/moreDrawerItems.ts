import type { LucideIcon } from 'lucide-react'
import { Plug, Sparkles, CalendarClock, Code2, Settings, LogOut, Plus, Folder, Clock, SquarePlus, History } from 'lucide-react'

export interface MoreDrawerItem {
  key: string
  label: string
  icon: LucideIcon
  to?: string
  dialog?: string
  danger?: boolean
}

export interface NavPrimaryCta {
  key: string
  label: string
  icon: LucideIcon
  to?: string
  onSelect?: 'new-session' | 'new-repo' | 'new-automation' | 'history'
  variant?: 'primary' | 'secondary'
}

export interface NavModel {
  primary: NavPrimaryCta[]
  items: MoreDrawerItem[]
}

function getBaseItems(): MoreDrawerItem[] {
  return [
    { key: 'settings', label: 'Settings', icon: Settings },
    { key: 'logout', label: 'Logout', icon: LogOut },
  ]
}

export function buildNavModel(pathname: string): NavModel {
  const baseItems = getBaseItems()

  const projectDetailMatch = /^\/projects\/(\d+)$/.exec(pathname)
  if (projectDetailMatch) {
    const id = projectDetailMatch[1]
    const items: MoreDrawerItem[] = [
      { key: 'files', label: 'Files', icon: Folder, dialog: 'files' },
      { key: 'mcp', label: 'MCP', icon: Plug, dialog: 'mcp' },
      { key: 'skills', label: 'Skills', icon: Sparkles, dialog: 'skills' },
      { key: 'lsp', label: 'LSP', icon: Code2, dialog: 'lsp' },
      { key: 'automations', label: 'automations', icon: CalendarClock, to: `/projects/${id}/automations` },
      { key: 'history', label: 'History', icon: History, to: '/history' },
      ...baseItems,
    ]

    return {
      primary: [
        { key: 'new-session', label: 'New Session', icon: SquarePlus, onSelect: 'new-session', variant: 'primary' },
      ],
      items,
    }
  }

  const sessionDetailMatch = /^\/projects\/(\d+)\/sessions\/[^/]+$/.exec(pathname)
  if (sessionDetailMatch) {
    const items: MoreDrawerItem[] = [
      { key: 'files', label: 'Files', icon: Folder, dialog: 'files' },
      { key: 'mcp', label: 'MCP', icon: Plug, dialog: 'mcp' },
      { key: 'skills', label: 'Skills', icon: Sparkles, dialog: 'skills' },
      { key: 'lsp', label: 'LSP', icon: Code2, dialog: 'lsp' },
      { key: 'automations', label: 'automations', icon: CalendarClock, to: `/projects/${sessionDetailMatch[1]}/automations` },
      { key: 'history', label: 'History', icon: History, to: '/history' },
      ...baseItems,
    ]

    return {
      primary: [
        { key: 'new-session', label: 'New Session', icon: SquarePlus, onSelect: 'new-session', variant: 'primary' },
      ],
      items,
    }
  }

  if (pathname === '/history') {
    return {
      primary: [
        { key: 'new-session', label: 'New Session', icon: SquarePlus, onSelect: 'new-session', variant: 'primary' },
      ],
      items: baseItems,
    }
  }

  if (pathname === '/automations' || /^\/projects\/\d+\/automations$/.test(pathname)) {
    return {
      primary: [
        { key: 'new-automation', label: 'New automation', icon: Clock, onSelect: 'new-automation', variant: 'primary' },
      ],
      items: [
        { key: 'history', label: 'History', icon: History, to: '/history' },
        ...baseItems,
      ],
    }
  }

  if (pathname === '/') {
    return {
      primary: [
        { key: 'new-project', label: 'New Project', icon: Plus, onSelect: 'new-repo', variant: 'primary' },
      ],
      items: [
        { key: 'all-automations', label: 'All automations', icon: CalendarClock, to: '/automations' },
        { key: 'files', label: 'Files', icon: Folder, dialog: 'files' },
        { key: 'history', label: 'History', icon: History, to: '/history' },
        ...baseItems,
      ],
    }
  }

  return {
    primary: [],
    items: baseItems,
  }
}

export function buildMoreItems(pathname: string): MoreDrawerItem[] {
  return buildNavModel(pathname).items
}
