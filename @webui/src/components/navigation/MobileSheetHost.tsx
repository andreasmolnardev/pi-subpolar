import { useMobileTabBar } from '@/hooks/useMobileTabBar'
import { useMobile } from '@/hooks/useMobile'
import { NotificationsSheet } from '@/components/navigation/NotificationsSheet'
import { MoreDrawer } from '@/components/navigation/MoreDrawer'

export function MobileSheetHost() {
  const isMobile = useMobile()
  const { openSheet, close } = useMobileTabBar()

  if (!isMobile) return null

  return (
    <>
      {openSheet === 'notifications' && <NotificationsSheet isOpen onClose={close} />}
      <MoreDrawer isOpen={openSheet === 'more'} onClose={close} />
    </>
  )
}
