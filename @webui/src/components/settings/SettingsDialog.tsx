import { useState, useEffect, useCallback } from 'react'
import { AppearanceSettings } from '@/components/settings/AppearanceSettings'
import { ChatSettings } from '@/components/settings/ChatSettings'
import { GeneralSettings } from '@/components/settings/GeneralSettings'
import { KeyboardShortcuts } from '@/components/settings/KeyboardShortcuts'
import { ProviderSettings } from '@/components/settings/ProviderSettings'
import { AccountSettings } from '@/components/settings/AccountSettings'
import { VoiceSettings } from '@/components/settings/VoiceSettings'
import { NotificationSettings } from '@/components/settings/NotificationSettings'
import { IntegrationsSettings } from '@/components/settings/IntegrationsSettings'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Settings2, Keyboard, ChevronLeft, Key, User, Volume2, Bell, X, MessageSquare, Palette, Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSettingsDialog } from '@/hooks/useSettingsDialog'

type SettingsView = 'menu' | 'general' | 'chat' | 'appearance' | 'shortcuts' | 'providers' | 'integrations' | 'account' | 'voice' | 'notifications'

export function SettingsDialog() {
  const { isOpen, close, activeTab, setActiveTab } = useSettingsDialog()
  const [mobileView, setMobileView] = useState<SettingsView>('menu')
  const [sectionHistory, setSectionHistory] = useState<SettingsView[]>([])

  const pushSectionHistory = useCallback((view: SettingsView) => {
    if (view === 'menu') return
    setSectionHistory((history) => {
      if (history.at(-1) === view) return history
      return [...history, view]
    })
  }, [])

  const handleSettingsBack = useCallback(() => {
    if (mobileView === 'menu') {
      close()
      return
    }

    const currentIndex = sectionHistory.lastIndexOf(mobileView)
    const previousHistory = currentIndex >= 0
      ? sectionHistory.slice(0, currentIndex)
      : sectionHistory
    const previousView = previousHistory.at(-1)

    if (previousView) {
      setSectionHistory(previousHistory)
      setMobileView(previousView)
      setActiveTab(previousView)
      return
    }

    setSectionHistory([])
    setMobileView('menu')
  }, [mobileView, sectionHistory, close, setActiveTab])

  useEffect(() => {
    if (!isOpen) {
      setMobileView('menu')
      setSectionHistory([])
      return
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
      }
    }
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isOpen, close])

  const menuItems = [
    { id: 'account', icon: User, label: 'Account', description: 'Profile, passkeys, and sign out' },
    { id: 'general', icon: Settings2, label: 'General Settings', description: 'App preferences and behavior' },
    { id: 'chat', icon: MessageSquare, label: 'Chat', description: 'Message display and chat behavior' },
    { id: 'appearance', icon: Palette, label: 'Appearance', description: 'Theme and visual preferences' },
    { id: 'notifications', icon: Bell, label: 'Notifications', description: 'Push notification preferences' },
    { id: 'voice', icon: Volume2, label: 'Voice', description: 'Text-to-speech and speech-to-text settings' },
    { id: 'shortcuts', icon: Keyboard, label: 'Keyboard Shortcuts', description: 'Customize keyboard shortcuts' },
    { id: 'integrations', icon: Plug, label: 'Integrations', description: 'Configure MCP, calendars, and mail' },
    { id: 'providers', icon: Key, label: 'Models', description: 'Manage AI providers and default models' },
  ]

  const handleOpenMobileView = useCallback((view: SettingsView) => {
    setMobileView(view)
    setActiveTab(view)
    pushSectionHistory(view)
  }, [setActiveTab, pushSectionHistory])

  // handleTabChange removed – sidebar handles navigation

   return (
      <Dialog open={isOpen} modal={false} onOpenChange={(open) => !open && close()}>
        <DialogContent 
          className="inset-0 w-full h-full max-w-none max-h-none p-0 rounded-none bg-gradient-to-br from-background via-background to-background border-border overflow-hidden !flex !flex-col !gap-0"
          fullscreen
          canSwipeBack={() => mobileView !== 'menu'}
          onSwipeBack={handleSettingsBack}
          onInteractOutside={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
<div className="hidden sm:flex sm:flex-col sm:h-full sm:min-h-0">
            <div className="sticky top-0 z-10 bg-gradient-to-b from-background via-background to-transparent border-b border-border backdrop-blur-sm px-6 py-4 flex-shrink-0 flex items-center justify-between">
              <h2 className="text-2xl font-semibold bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
                Settings
              </h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={close}
                className="text-muted-foreground hover:text-foreground min-w-[44px] min-h-[44px]"
              >
                <X className="w-5 h-5" />
              </Button>
            </div>
            <div className="flex flex-1 overflow-hidden">
              {/* Sidebar menu */}
              <nav className="w-64 flex-shrink-0 border-r border-border bg-card p-4">
                {menuItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { setActiveTab(item.id as SettingsView); setMobileView(item.id as SettingsView); pushSectionHistory(item.id as SettingsView); }}
                    className={`w-full text-left px-3 py-2 rounded-md mb-2 flex items-center gap-2 ${activeTab === item.id ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:bg-gray-200'} transition-colors`}
                  >
                    <item.icon className="w-5 h-5" />
                    <span>{item.label}</span>
                  </button>
                ))}
              </nav>
              {/* Content area */}
              <div className="flex-1 overflow-y-auto p-6">
                {activeTab === 'account' && <AccountSettings />}
                {activeTab === 'general' && <GeneralSettings />}
                {activeTab === 'chat' && <ChatSettings />}
                {activeTab === 'appearance' && <AppearanceSettings />}
                {activeTab === 'notifications' && <NotificationSettings />}
                {activeTab === 'voice' && <VoiceSettings />}
                {activeTab === 'shortcuts' && <KeyboardShortcuts />}
                {activeTab === 'providers' && <ProviderSettings />}
                {activeTab === 'integrations' && <IntegrationsSettings />}
              </div>
            </div>
          </div>

        <div className="sm:hidden flex flex-col h-full min-h-0">
           <div className="flex-shrink-0 bg-gradient-to-b from-background via-background to-transparent border-b border-border backdrop-blur-sm px-4 py-4 flex items-center justify-between">
             <div className="flex items-center gap-2 flex-1">
                {mobileView !== 'menu' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleSettingsBack}
                    className="text-muted-foreground hover:text-foreground min-w-[44px] min-h-[44px]"
                  >
                    <ChevronLeft className="w-6 h-6" />
                  </Button>
                )}
               <h2 className="text-xl font-semibold bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
                 {mobileView === 'menu' ? 'Settings' : menuItems.find(item => item.id === mobileView)?.label}
               </h2>
             </div>
             <Button
               variant="ghost"
               size="icon"
               onClick={close}
               className="text-muted-foreground hover:text-foreground min-w-[44px] min-h-[44px] flex-shrink-0"
             >
               <X className="w-6 h-6" />
             </Button>
           </div>

           <div className="flex-1 min-h-0 overflow-y-auto p-4 pb-32">
             {mobileView === 'menu' && (
               <div className="space-y-3">
                 {menuItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => handleOpenMobileView(item.id as SettingsView)}
                      className="w-full bg-gradient-to-br from-card to-card-hover border border-border rounded-xl p-4 hover:border-border transition-all duration-200 text-left"
                    >
                     <div className="flex items-center gap-4">
                       <div className="p-3 bg-accent rounded-lg">
                         <item.icon className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                       </div>
                       <div className="flex-1 min-w-0">
                         <h3 className="font-semibold text-foreground mb-1">{item.label}</h3>
                         <p className="text-sm text-muted-foreground">{item.description}</p>
                       </div>
                     </div>
                   </button>
                 ))}
               </div>
             )}

              {mobileView === 'account' && <div key="account"><AccountSettings /></div>}
              {mobileView === 'general' && <div key="general"><GeneralSettings /></div>}
              {mobileView === 'chat' && <div key="chat"><ChatSettings /></div>}
              {mobileView === 'appearance' && <div key="appearance"><AppearanceSettings /></div>}
              {mobileView === 'notifications' && <div key="notifications"><NotificationSettings /></div>}
             {mobileView === 'voice' && <div key="voice"><VoiceSettings /></div>}
              {mobileView === 'shortcuts' && <div key="shortcuts"><KeyboardShortcuts /></div>}
               {mobileView === 'providers' && <div key="providers"><ProviderSettings /></div>}
               {mobileView === 'integrations' && <div key="integrations"><IntegrationsSettings /></div>}
           </div>
        </div>

      </DialogContent>
    </Dialog>
  )
}
