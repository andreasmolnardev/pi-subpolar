import { useSettings } from '@/hooks/useSettings'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { getProviders } from '@/api/providers'
import { SUBPOLAR_API_BASE_URL } from '@/config'
import { useConfig } from '@/hooks/usePiDurableHarness'

export function ChatSettings() {
  const { preferences, isLoading, updateSettings, isUpdating } = useSettings()
  const { data: config } = useConfig(SUBPOLAR_API_BASE_URL)

  const { data: providersData } = useQuery({
    queryKey: ['subpolar', 'providers', SUBPOLAR_API_BASE_URL],
    queryFn: () => getProviders(),
    staleTime: 30000,
  })

  const models = useMemo(() => {
    const providers = providersData?.providers
    if (!providers) return []

    const configuredProviders = config?.provider ?? {}
    const disabledProviders = new Set(config?.disabled_providers ?? [])
    const connectedProviders = new Set(providersData?.connected ?? [])

    return providers.flatMap((provider) => {
      if (disabledProviders.has(provider.id)) return []

      const isConfigured = provider.id in configuredProviders
      const isConnected = connectedProviders.has(provider.id)
      if (!isConfigured && !isConnected) return []

      const configuredModels = configuredProviders[provider.id]?.models
      const enabledModelKeys = configuredModels ? new Set(Object.keys(configuredModels)) : null

      return Object.entries(provider.models).flatMap(([key, model]) => {
        if (enabledModelKeys && !enabledModelKeys.has(key)) return []

        return [{
          id: `${provider.id}/${key}`,
          name: model.name || key,
          providerName: provider.name,
        }]
      })
    })
  }, [providersData, config])

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, typeof models>()
    for (const model of models) {
      const group = map.get(model.providerName) ?? []
      group.push(model)
      map.set(model.providerName, group)
    }
    return map
  }, [models])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-6">Chat Preferences</h2>

      <div className="space-y-6">
        <div className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="defaultModel" className="text-base">Default model</Label>
            <p className="text-sm text-muted-foreground">
              Choose the model selected by default for new chats
            </p>
          </div>
          <Select
            value={preferences?.defaultModel ?? '__auto__'}
            onValueChange={(value) => updateSettings({ defaultModel: value === '__auto__' ? undefined : value })}
          >
            <SelectTrigger id="defaultModel" className="w-[240px]">
              <SelectValue placeholder="Auto Model" />
            </SelectTrigger>
            <SelectContent className="max-h-[300px] overflow-y-auto">
              <SelectItem value="__auto__">Auto Model</SelectItem>
              <SelectSeparator />
              {Array.from(modelsByProvider.entries()).map(([providerName, providerModels], index) => (
                <SelectGroup key={providerName}>
                  {index > 0 && <SelectSeparator />}
                  <SelectLabel>{providerName}</SelectLabel>
                  {providerModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="simpleChatMode" className="text-base">Simple chat mode</Label>
            <p className="text-sm text-muted-foreground">
              Show only your messages and the assistant's replies. Hides tool calls, reasoning, diffs, and agent details.
            </p>
          </div>
          <Switch
            id="simpleChatMode"
            checked={preferences?.simpleChatMode ?? false}
            onCheckedChange={(checked) => updateSettings({ simpleChatMode: checked })}
          />
        </div>

        <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="autoScroll" className="text-base">Auto-scroll</Label>
            <p className="text-sm text-muted-foreground">
              Automatically scroll to bottom when new messages arrive
            </p>
          </div>
          <Switch
            id="autoScroll"
            checked={preferences?.autoScroll ?? true}
            onCheckedChange={(checked) => updateSettings({ autoScroll: checked })}
          />
        </div>

        {!preferences?.simpleChatMode && (
          <>
            <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="showReasoning" className="text-base">Show thinking</Label>
                <p className="text-sm text-muted-foreground">
                  Display model thinking trails
                </p>
              </div>
              <Switch
                id="showReasoning"
                checked={preferences?.showReasoning ?? false}
                onCheckedChange={(checked) => updateSettings({ showReasoning: checked })}
              />
            </div>

            <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="expandToolCalls" className="text-base">Expand tool calls</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically expand tool call details by default
                </p>
              </div>
              <Switch
                id="expandToolCalls"
                checked={preferences?.expandToolCalls ?? false}
                onCheckedChange={(checked) => updateSettings({ expandToolCalls: checked })}
              />
            </div>

            <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="expandDiffs" className="text-base">Expand diffs</Label>
                <p className="text-sm text-muted-foreground">
                  Show file diffs expanded by default for edit operations
                </p>
              </div>
              <Switch
                id="expandDiffs"
                checked={preferences?.expandDiffs ?? true}
                onCheckedChange={(checked) => updateSettings({ expandDiffs: checked })}
              />
            </div>
          </>
        )}

        {isUpdating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Saving...</span>
          </div>
        )}
      </div>

    </div>
  )
}
