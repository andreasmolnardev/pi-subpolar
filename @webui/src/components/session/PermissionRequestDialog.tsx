import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { PermissionRequest, PermissionResponse } from '@/api/types'
import { getPermissionLabel, getPermissionDetail } from '@subpolar/shared/notifications'
import { cn } from '@/lib/utils'
import { showToast } from '@/lib/toast'

interface PermissionRequestDialogProps {
  permission: PermissionRequest | null
  pendingCount: number
  isFromDifferentSession?: boolean
  sessionTitle?: string
  repoDirectory?: string | null
  onRespond: (permissionID: string, sessionID: string, response: PermissionResponse) => Promise<void>
}

export function PermissionRequestDialog({
  permission,
  pendingCount,
  isFromDifferentSession,
  sessionTitle,
  repoDirectory,
  onRespond,
}: PermissionRequestDialogProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [loadingAction, setLoadingAction] = useState<PermissionResponse | null>(null)

  if (!permission) return null

  const handleResponse = async (response: PermissionResponse) => {
    setIsLoading(true)
    setLoadingAction(response)
    try {
      await onRespond(permission.id, permission.sessionID, response)
    } catch {
      showToast.error('Failed to respond to permission. Please try again.')
    } finally {
      setIsLoading(false)
      setLoadingAction(null)
    }
  }

  const typeLabel = getPermissionLabel(permission.permission)
  const details = getPermissionDetail(permission)
  const hasMultiple = pendingCount > 1
  const displaySessionName = sessionTitle || `Session ${permission.sessionID.slice(0, 8)}...`
  const canAllowAlways = permission.always.length > 0

  return (
    <div className="mb-2 overflow-hidden rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur-md">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Permission Request</h3>
            {hasMultiple && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                +{pendingCount - 1} more
              </span>
            )}
          </div>
          <p className="mt-0.5 break-words text-xs text-muted-foreground">
            {`Allow ${typeLabel.toLowerCase()}?`}
          </p>
        </div>
        <span className="rounded bg-muted px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {typeLabel}
        </span>
      </div>

      <div className="mt-3 space-y-2 overflow-hidden">
        {details.primary && (
          <div className="max-h-28 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/50 p-2">
            <pre className="w-full whitespace-pre-wrap break-all font-mono text-xs">
              {details.primary}
            </pre>
          </div>
        )}

        {details.secondary && (
          <div className="max-h-20 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/30 p-2">
            <pre className="w-full whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
              {details.secondary}
            </pre>
          </div>
        )}

        <div className="space-y-1 text-xs text-muted-foreground">
          {repoDirectory && (
            <div className="truncate">
              Repo: <span className="font-medium">{repoDirectory.split('/').pop() ?? repoDirectory}</span>
            </div>
          )}
          {isFromDifferentSession ? (
            <div className="truncate rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-amber-600 dark:text-amber-400">
              From another session: <span className="font-medium">{displaySessionName}</span>
            </div>
          ) : (
            <div className="truncate">
              Session: <span className="font-medium">{displaySessionName}</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <Button
          variant="outline"
          onClick={() => handleResponse('reject')}
          disabled={isLoading}
          className={cn("h-9 text-sm", loadingAction === 'reject' && "opacity-70")}
        >
          {loadingAction === 'reject' ? 'Denying...' : 'Deny'}
        </Button>
        {canAllowAlways && (
          <Button
            variant="secondary"
            onClick={() => handleResponse('always')}
            disabled={isLoading}
            className={cn("h-9 text-sm", loadingAction === 'always' && "opacity-70")}
          >
            {loadingAction === 'always' ? 'Allowing...' : 'Allow Always'}
          </Button>
        )}
        <Button
          variant="default"
          onClick={() => handleResponse('once')}
          disabled={isLoading}
          className={cn("h-9 text-sm", !canAllowAlways && "col-span-1", loadingAction === 'once' && "opacity-70")}
        >
          {loadingAction === 'once' ? 'Allowing...' : 'Allow'}
        </Button>
      </div>
    </div>
  )
}
