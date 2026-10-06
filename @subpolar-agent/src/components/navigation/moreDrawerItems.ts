import type { LucideIcon } from 'lucide-react'
import { Plus, SquarePlus, History } from 'lucide-react'

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

function getBaseItems(): MoreDrawerItem[] { return [] }

export function buildNavModel(pathname: string): NavModel {
  const baseItems = getBaseItems()

  const projectDetailMatch = /^\/projects\/(\d+)$/.exec(pathname)
  if (projectDetailMatch) {
    const items: MoreDrawerItem[] = [
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

  if (pathname === '/') {
    return {
      primary: [
        { key: 'new-project', label: 'New Project', icon: Plus, onSelect: 'new-repo', variant: 'primary' },
      ],
      items: [
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
