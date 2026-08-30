import { useCallback, useRef } from 'react'
import { useUrlParams } from './useUrlParams'

const settingsTabs = ['account', 'general', 'chat', 'appearance', 'notifications', 'voice', 'shortcuts', 'providers', 'integrations', 'menu'] as const

type Tab = typeof settingsTabs[number]

function isSettingsTab(value: string | null): value is Tab {
  return settingsTabs.some((tab) => tab === value)
}

interface UseSettingsDialogReturn {
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
  activeTab: Tab
  setActiveTab: (tab: Tab) => void
}

export function useSettingsDialog(): UseSettingsDialogReturn {
  const { searchParams, updateParams } = useUrlParams()

  const isOpen = searchParams.get('settings') === 'open'
  const requestedTab = searchParams.get('settingsTab')
  const activeTab = isSettingsTab(requestedTab) ? requestedTab : 'account'

  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const open = useCallback(() => {
    updateParams((p) => {
      p.set('settings', 'open')
      p.set('settingsTab', activeTabRef.current)
      p.delete('mobileTab')
    }, 'push')
  }, [updateParams])

  const close = useCallback(() => {
    updateParams((p) => {
      p.delete('settings')
      p.delete('settingsTab')
    }, 'replace')
  }, [updateParams])

  const toggle = useCallback(() => {
    const isCurrentlyOpen = searchParams.get('settings') === 'open'
    if (isCurrentlyOpen) {
      close()
    } else {
      open()
    }
  }, [searchParams, open, close])

  const setActiveTab = useCallback((tab: Tab) => {
    updateParams((p) => {
      p.set('settings', 'open')
      p.set('settingsTab', tab)
    }, 'replace')
  }, [updateParams])

  return {
    isOpen,
    open,
    close,
    toggle,
    activeTab,
    setActiveTab,
  }
}
