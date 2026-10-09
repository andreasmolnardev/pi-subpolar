import { useMemo, useState } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { useVersionCheck } from '@/hooks/useVersionCheck'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getHiddenAgents } from '@/lib/agentVisibility'
import { useAgents } from '@/hooks/usePiHarness'
import { SUBPOLAR_API_BASE_URL } from '@/config'

type AgentOption = { name: string }

function AgentVisibilityDialog({
  open,
  onOpenChange,
  agents,
  hiddenAgents,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agents: AgentOption[]
  hiddenAgents: string[]
  onChange: (hiddenAgents: string[]) => void
}) {
  const hiddenAgentNames = useMemo(() => new Set(hiddenAgents.map((name) => name.toLowerCase())), [hiddenAgents])

  const handleCheckedChange = (agentName: string, checked: boolean) => {
    if (checked) {
      onChange(hiddenAgents.filter((name) => name.toLowerCase() !== agentName.toLowerCase()))
      return
    }

    if (!hiddenAgentNames.has(agentName.toLowerCase())) onChange([...hiddenAgents, agentName])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hidden agents</DialogTitle>
          <DialogDescription>Checked agents are available in chat and the sidebar. Deselect an agent to hide it in both places.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
          {agents.map((agent) => (
            <label key={agent.name} className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
              <Checkbox checked={!hiddenAgentNames.has(agent.name.toLowerCase())} onCheckedChange={(value) => handleCheckedChange(agent.name, value === true)} />
              <span className="text-sm font-medium">{agent.name}</span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GeneralSettings() {
  const { preferences, isLoading, updateSettings } = useSettings()
  const { data: agents = [] } = useAgents(SUBPOLAR_API_BASE_URL)
  const [isAgentVisibilityOpen, setIsAgentVisibilityOpen] = useState(false)
  const { data: versionInfo, isLoading: isVersionLoading } = useVersionCheck()
  const hiddenAgents = getHiddenAgents(preferences)

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
        <div className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <h3 className="text-base font-medium">Hidden agents</h3>
            <p className="text-sm text-muted-foreground">Choose which agents appear in chat and the sidebar.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => setIsAgentVisibilityOpen(true)}>Configure</Button>
        </div>

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

      </div>
      <AgentVisibilityDialog
        open={isAgentVisibilityOpen}
        onOpenChange={setIsAgentVisibilityOpen}
        agents={agents}
        hiddenAgents={hiddenAgents}
        onChange={(hiddenAgents) => updateSettings({ hiddenAgents })}
      />
    </div>
  )
}
