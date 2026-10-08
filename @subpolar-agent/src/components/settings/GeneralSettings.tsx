import { useSettings } from '@/hooks/useSettings'
import { useVersionCheck } from '@/hooks/useVersionCheck'
import { Loader2 } from 'lucide-react'

export function GeneralSettings() {
  const { isLoading } = useSettings()
  const { data: versionInfo, isLoading: isVersionLoading } = useVersionCheck()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-6">General Preferences</h2>

      <div className="space-y-6">
        <div className="flex items-center justify-center gap-3 py-3">
          <span className="text-sm text-muted-foreground">subpolar</span>
          {isVersionLoading ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : versionInfo?.currentVersion ? (
            <>
              <span className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
                {versionInfo.currentVersion}
              </span>
              {versionInfo.updateAvailable && versionInfo.latestVersion && (
                <a
                  href={versionInfo.releaseUrl ?? ''}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-green-500 hover:text-green-400 transition-colors"
                >
                  v{versionInfo.latestVersion} available
                </a>
              )}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">unknown</span>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Chat display options moved to Chat. Theme selection moved to Appearance.
        </p>
      </div>
    </div>
  )
}
