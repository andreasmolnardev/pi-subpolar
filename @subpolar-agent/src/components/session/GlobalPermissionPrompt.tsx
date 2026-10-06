import { useLocation } from 'react-router-dom'
import { PermissionRequestDialog } from './PermissionRequestDialog'
import { usePermissions } from '@/contexts/EventContext'

function activeSessionID(pathname: string): string | null {
  const match = pathname.match(/\/sessions\/([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

export function GlobalPermissionPrompt() {
  const location = useLocation()
  const {
    current: permission,
    pendingCount,
    respond,
    showDialog,
  } = usePermissions()

  if (!showDialog || !permission || permission.sessionID === activeSessionID(location.pathname)) {
    return null
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-2xl">
        <PermissionRequestDialog
          permission={permission}
          pendingCount={pendingCount}
          isFromDifferentSession
          onRespond={respond}
        />
      </div>
    </div>
  )
}
