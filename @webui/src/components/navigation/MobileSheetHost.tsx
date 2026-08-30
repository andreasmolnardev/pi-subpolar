import { useMobileTabBar } from '@/hooks/useMobileTabBar'
import { useMobile } from '@/hooks/useMobile'
import { FileBrowserSheet } from '@/components/file-browser/FileBrowserSheet'
import { NotificationsSheet } from '@/components/navigation/NotificationsSheet'
import { MoreDrawer } from '@/components/navigation/MoreDrawer'

export function MobileSheetHost() {
  const isMobile = useMobile()
  const { openSheet, close } = useMobileTabBar()

  if (!isMobile) return null

  return (
    <>
      {openSheet === 'files' && (
        <FileBrowserSheet
          isOpen
          onClose={close}
          basePath=""
          repoName="Workspace Root"
          allowNavigateAboveBase={true}
        />
      )}
      {openSheet === 'notifications' && <NotificationsSheet isOpen onClose={close} />}
      <MoreDrawer isOpen={openSheet === 'more'} onClose={close} />
    </>
  )
}
