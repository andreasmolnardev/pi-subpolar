import { useState, useMemo, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Check, X, Shield, Search, Pencil, Trash2, Plus, RefreshCw } from 'lucide-react'
import { providerAccountsApi, getProviders, customProvidersApi } from '@/api/providers'
import type { CustomProviderConfig, PiProviderApiType, Provider, ProviderCatalogProvider, ProviderInstance, ProviderAuthMethodKind } from '@/api/providers'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiKeyDialog, type ProviderLoginTarget } from '@/components/model/ApiKeyDialog'
import { invalidateProviderCaches } from '@/lib/queryInvalidation'
import { useSettings } from '@/hooks/useSettings'
import type { DefaultModels } from '@/api/types/settings'

const NO_MODEL_VALUE = '__none__'

const DEFAULT_MODEL_FIELDS = [
  { key: 'routing', label: 'Routing model', description: 'Chooses agents, tools, or model routes for a prompt.' },
  { key: 'compaction', label: 'Compaction model', description: 'Condenses long conversations when context is tight.' },
  { key: 'sessionNaming', label: 'Session naming model', description: 'Generates concise chat titles.' },
  { key: 'summary', label: 'Summary model', description: 'Produces session and handoff summaries.' },
  { key: 'toolSummary', label: 'Tool result summary model', description: 'Compresses noisy tool output into readable context.' },
] as const

type DefaultModelKey = typeof DEFAULT_MODEL_FIELDS[number]['key']

function getModelValue(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

function getModelCapabilities(model: Provider['models'][string]): string[] {
  const capabilities: string[] = []
  if (model.reasoning) capabilities.push('reasoning')
  if (model.tool_call) capabilities.push('tools')
  if (model.attachment) capabilities.push('attachments')
  if (model.limit?.context) capabilities.push(`${model.limit.context.toLocaleString()} ctx`)
  if (model.limit?.output) capabilities.push(`${model.limit.output.toLocaleString()} out`)
  return capabilities
}

function ModelSelect({
  value,
  providers,
  placeholder,
  onChange,
}: {
  value?: string
  providers: Provider[]
  placeholder: string
  onChange: (value: string | undefined) => void
}) {
  return (
    <Select value={value ?? NO_MODEL_VALUE} onValueChange={(nextValue) => onChange(nextValue === NO_MODEL_VALUE ? undefined : nextValue)}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectItem value={NO_MODEL_VALUE}>{placeholder}</SelectItem>
        {providers.map((provider) => (
          <SelectGroup key={provider.id}>
            <SelectLabel>{provider.name || provider.id}</SelectLabel>
            {Object.entries(provider.models || {}).map(([modelId, model]) => {
              const capabilities = getModelCapabilities(model)
              return (
                <SelectItem key={`${provider.id}/${modelId}`} value={getModelValue(provider.id, modelId)}>
                  <span className="flex flex-col">
                    <span>{model.name || modelId}</span>
                    <span className="text-xs text-muted-foreground">
                      {capabilities.length > 0 ? capabilities.join(' · ') : modelId}
                    </span>
                  </span>
                </SelectItem>
              )
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

function DefaultModelsSettings({ providers, conversationProviders }: { providers: Provider[], conversationProviders: Provider[] }) {
  const { preferences, updateSettings, isUpdating } = useSettings()
  const defaultModels = useMemo(() => preferences?.defaultModels ?? {}, [preferences?.defaultModels])

  const handleConversationModelChange = useCallback((model: string | undefined) => {
    updateSettings({ defaultModel: model })
  }, [updateSettings])

  const handleInternalModelChange = useCallback((key: DefaultModelKey, model: string | undefined) => {
    const nextModels: DefaultModels = { ...defaultModels, [key]: model }
    if (!model) delete nextModels[key]
    updateSettings({ defaultModels: nextModels })
  }, [defaultModels, updateSettings])

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">Default Conversation Model</h2>
        <p className="text-sm text-muted-foreground">
          Used by new chats when the composer model selector is left on its default.
        </p>
        <ModelSelect
          value={preferences?.defaultModel}
          providers={conversationProviders}
          placeholder="Use runtime default"
          onChange={handleConversationModelChange}
        />
      </div>

      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-2">Internal Task Models</h2>
          <p className="text-sm text-muted-foreground">
            Defaults for background agent work. Model metadata includes name, limits, modalities, reasoning, tool support, status, and cost; providers do not expose a single standard prose description.
          </p>
        </div>

        <div className="grid gap-3">
          {DEFAULT_MODEL_FIELDS.map((field) => (
            <Card key={field.key} className="bg-card border-border">
              <CardHeader className="p-4">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(260px,360px)] md:items-center">
                  <div>
                    <CardTitle className="text-sm">{field.label}</CardTitle>
                    <CardDescription className="text-xs mt-1">{field.description}</CardDescription>
                  </div>
                  <ModelSelect
                    value={defaultModels[field.key]}
                    providers={providers}
                    placeholder="Use conversation default"
                    onChange={(model) => handleInternalModelChange(field.key, model)}
                  />
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>

      {isUpdating && <p className="text-xs text-muted-foreground">Saving model defaults...</p>}
    </div>
  )
}

const PI_PROVIDER_API_TYPES: PiProviderApiType[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'azure-openai-responses',
  'openai-codex-responses',
  'mistral-conversations',
  'google-generative-ai',
  'google-vertex',
  'bedrock-converse-stream',
]

type CustomProviderPreset = 'none' | 'lmstudio'

const LM_STUDIO_PRESET = {
  id: 'lmstudio',
  name: 'LM Studio',
  baseUrl: 'http://localhost:1234/v1',
  api: 'openai-responses' as PiProviderApiType,
}

function parseLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean)
}

function formatModels(provider: CustomProviderConfig | null): string {
  return provider?.models.map((model) => model.id).join('\n') ?? ''
}

function safeEditorHeaders(headers: Record<string, string> | undefined): string {
  const sensitive = /(api[-_ ]?key|authorization|credential|password|refresh|secret|token|cookie)/i
  const safe = Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key, sensitive.test(key) ? '' : value]))
  return JSON.stringify(safe, null, 2)
}

function CustomProviderDialog({
  open,
  provider,
  onOpenChange,
  onSave,
  isSaving,
}: {
  open: boolean
  provider: CustomProviderConfig | null
  onOpenChange: (open: boolean) => void
  onSave: (provider: CustomProviderConfig) => void
  isSaving: boolean
}) {
  const [id, setId] = useState(provider?.id ?? '')
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [api, setApi] = useState<PiProviderApiType>(provider?.api ?? 'openai-completions')
  const [apiKey, setApiKey] = useState('')
  const [authHeader, setAuthHeader] = useState(provider?.authHeader ?? false)
  const [models, setModels] = useState(formatModels(provider))
  const [headers, setHeaders] = useState(safeEditorHeaders(provider?.headers))
  const [error, setError] = useState<string | null>(null)
  const [preset, setPreset] = useState<CustomProviderPreset>('none')
  const [isDiscovering, setIsDiscovering] = useState(false)

  useEffect(() => {
    if (provider || preset !== 'lmstudio') return
    setId(LM_STUDIO_PRESET.id)
    setName(LM_STUDIO_PRESET.name)
    setBaseUrl(LM_STUDIO_PRESET.baseUrl)
    setApi(LM_STUDIO_PRESET.api)
    setAuthHeader(true)
    setHeaders('{}')
  }, [preset, provider])

  const handleSave = useCallback(async () => {
    const providerId = id.trim()
    const providerName = name.trim()
    const providerBaseUrl = baseUrl.trim()

    if (!providerId || !providerName || !providerBaseUrl) {
      setError('Provider ID, display name, and base URL are required.')
      return
    }

    let parsedHeaders: Record<string, string> | undefined
    try {
      const headerValue = headers.trim() ? JSON.parse(headers) as unknown : {}
      if (!headerValue || typeof headerValue !== 'object' || Array.isArray(headerValue)) {
        setError('Headers must be a JSON object.')
        return
      }
      parsedHeaders = Object.fromEntries(
        Object.entries(headerValue).filter((entry): entry is [string, string] => (
          typeof entry[0] === 'string' && typeof entry[1] === 'string'
        )),
      )
    } catch {
      setError('Headers must be valid JSON.')
      return
    }

    let modelIds = parseLines(models)
    if (preset === 'lmstudio') {
      setIsDiscovering(true)
      try {
        modelIds = await customProvidersApi.discoverModels(providerBaseUrl, apiKey.trim() || undefined)
      } catch {
        setError('Could not fetch models from LM Studio. Check the base URL, bearer token, and that the LM Studio server is running.')
        setIsDiscovering(false)
        return
      }
      setIsDiscovering(false)
    }

    if (modelIds.length === 0) {
      setError(preset === 'lmstudio' ? 'LM Studio did not return any models.' : 'At least one model is required.')
      return
    }

    onSave({
      id: providerId,
      name: providerName,
      baseUrl: providerBaseUrl,
      api,
      apiKey: apiKey.trim() || undefined,
      headers: parsedHeaders && Object.keys(parsedHeaders).length > 0 ? parsedHeaders : undefined,
      authHeader,
      models: modelIds.map((modelId) => ({
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 16384,
      })),
    })
  }, [api, apiKey, authHeader, baseUrl, headers, id, models, name, onSave, preset])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{provider ? 'Edit Custom Provider' : 'Add Custom Provider'}</DialogTitle>
          <DialogDescription>
            Add a Pi-compatible provider backed by a custom endpoint.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {!provider && (
            <div className="space-y-2">
              <Label>Preset</Label>
              <Select value={preset} onValueChange={(value) => setPreset(value as CustomProviderPreset)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="lmstudio">LM Studio</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-2 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="custom-provider-id">Provider ID</Label>
              <Input id="custom-provider-id" value={id} onChange={(event) => setId(event.target.value)} disabled={Boolean(provider)} placeholder="my-provider" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-provider-name">Display Name</Label>
              <Input id="custom-provider-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="My Provider" />
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_220px]">
            <div className="space-y-2">
              <Label htmlFor="custom-provider-base-url">Base URL</Label>
              <Input id="custom-provider-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
            </div>
            <div className="space-y-2">
              <Label>API Type</Label>
              <Select value={api} onValueChange={(value) => setApi(value as PiProviderApiType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PI_PROVIDER_API_TYPES.map((apiType) => <SelectItem key={apiType} value={apiType}>{apiType}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div className="space-y-2">
              <Label htmlFor="custom-provider-api-key">{preset === 'lmstudio' ? 'Bearer Token (optional)' : 'API Key or Config Value (optional)'}</Label>
              <Input id="custom-provider-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={preset === 'lmstudio' ? 'Enter only when needed' : '$MY_PROVIDER_API_KEY'} autoComplete="new-password" />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch checked={authHeader} onCheckedChange={setAuthHeader} />
              <Label>Bearer auth header</Label>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="custom-provider-models">Model IDs</Label>
              <Textarea id="custom-provider-models" value={models} onChange={(event) => setModels(event.target.value)} placeholder={preset === 'lmstudio' ? 'Fetched from LM Studio on save' : 'model-one\nmodel-two'} className="min-h-28" disabled={preset === 'lmstudio'} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-provider-headers">Headers JSON</Label>
              <Textarea id="custom-provider-headers" value={headers} onChange={(event) => setHeaders(event.target.value)} className="min-h-28 font-mono text-xs" />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving || isDiscovering}>Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving || isDiscovering}>
            {(isSaving || isDiscovering) && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Provider
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function statusLabel(state: ProviderInstance['status']['state']): string {
  if (state === 'authenticated') return 'Connected'
  if (state === 'expired') return 'Expired'
  if (state === 'error') return 'Needs attention'
  if (state === 'unconfigured') return 'Not connected'
  return 'Unknown'
}

function statusBadge(instance: ProviderInstance) {
  const connected = instance.status.configured
  return (
    <Badge variant={connected ? 'default' : 'secondary'} className={connected ? 'bg-green-600 hover:bg-green-700 shrink-0' : 'shrink-0'}>
      {connected ? <Check className="h-3 w-3 mr-1" /> : <X className="h-3 w-3 mr-1" />}
      {statusLabel(instance.status.state)}
    </Badge>
  )
}

function loginTarget(provider: ProviderCatalogProvider, instance: ProviderInstance, preferredKind?: ProviderAuthMethodKind): ProviderLoginTarget {
  const methods = preferredKind
    ? [...provider.authMethods].sort((left) => left.kind === preferredKind ? -1 : 1)
    : provider.authMethods
  return {
    providerId: provider.id,
    instanceId: instance.instanceId,
    name: provider.name,
    methods,
    env: [],
  }
}

export function ProviderSettings() {
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)
  const [apiKeyTarget, setApiKeyTarget] = useState<ProviderLoginTarget | null>(null)
  const [apiKeyMode, setApiKeyMode] = useState<'add' | 'edit'>('add')
  const [deleteTarget, setDeleteTarget] = useState<ProviderInstance | null>(null)
  const [availableSearch, setAvailableSearch] = useState('')
  const [customProviderDialogOpen, setCustomProviderDialogOpen] = useState(false)
  const [customProviderTarget, setCustomProviderTarget] = useState<CustomProviderConfig | null>(null)
  const [customProviderDeleteTarget, setCustomProviderDeleteTarget] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: providersData, isLoading: providersLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: () => getProviders(),
    staleTime: 30000,
  })
  const providers = providersData?.providers ?? []
  const catalogProviders = providersData?.catalog?.providers ?? []

  const { data: customProviders = [], isLoading: customProvidersLoading } = useQuery({
    queryKey: ['custom-providers'],
    queryFn: () => customProvidersApi.list(),
    retry: false,
  })

  const deleteAccountMutation = useMutation({
    mutationFn: (instanceId: string) => providerAccountsApi.delete(instanceId),
    onSuccess: () => {
      setDeleteTarget(null)
      invalidateProviderCaches(queryClient)
    },
  })

  const saveCustomProviderMutation = useMutation({
    mutationFn: (provider: CustomProviderConfig) => customProvidersApi.save(provider),
    onSuccess: () => {
      setCustomProviderDialogOpen(false)
      setCustomProviderTarget(null)
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      invalidateProviderCaches(queryClient)
    },
  })

  const deleteCustomProviderMutation = useMutation({
    mutationFn: (providerId: string) => customProvidersApi.delete(providerId),
    onSuccess: () => {
      setCustomProviderDeleteTarget(null)
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      invalidateProviderCaches(queryClient)
    },
  })

  const openLogin = useCallback((provider: ProviderCatalogProvider, instance: ProviderInstance, mode: 'add' | 'edit') => {
    setApiKeyTarget(loginTarget(provider, instance, mode === 'edit' ? instance.authMethod : undefined))
    setApiKeyMode(mode)
    setApiKeyDialogOpen(true)
  }, [])

  const filteredProviders = useMemo(() => {
    const search = availableSearch.trim().toLowerCase()
    if (!search) return catalogProviders
    return catalogProviders.filter((provider) => (
      provider.name.toLowerCase().includes(search) || provider.id.toLowerCase().includes(search) ||
      provider.instances.some((instance) => instance.label.toLowerCase().includes(search) || instance.email?.toLowerCase().includes(search))
    ))
  }, [availableSearch, catalogProviders])

  const connectedInstances = useMemo(
    () => catalogProviders.flatMap((provider) => provider.instances.filter((instance) => instance.status.configured)),
    [catalogProviders],
  )

  const conversationProviders = useMemo(
    () => providers.filter((provider) => provider.isConnected),
    [providers],
  )

  const handleApiKeySuccess = useCallback(() => {
    setApiKeyDialogOpen(false)
    setApiKeyTarget(null)
    invalidateProviderCaches(queryClient)
  }, [queryClient])

  const handleApiKeyDialogClose = useCallback((open: boolean) => {
    setApiKeyDialogOpen(open)
    if (!open) setApiKeyTarget(null)
  }, [])

  if (providersLoading || customProvidersLoading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  return (
    <Tabs defaultValue="defaults" className="space-y-6">
      <TabsList className="w-full justify-start">
        <TabsTrigger value="defaults">Default Models</TabsTrigger>
        <TabsTrigger value="providers">Providers</TabsTrigger>
      </TabsList>

      <TabsContent value="defaults" className="px-0">
        <DefaultModelsSettings providers={providers} conversationProviders={conversationProviders} />
      </TabsContent>

      <TabsContent value="providers" className="px-0">
        <div className="space-y-8">
          <section className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">Provider Accounts</h2>
                <p className="text-sm text-muted-foreground">
                  Each account is a separate provider instance. Credentials stay on the server and are never displayed.
                </p>
              </div>
              <Badge variant="secondary">{connectedInstances.length} connected</Badge>
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search providers or accounts..." value={availableSearch} onChange={(event) => setAvailableSearch(event.target.value)} className="pl-9" autoComplete="off" />
            </div>

            {filteredProviders.length === 0 ? (
              <Card className="bg-card border-border"><CardContent className="pt-6"><p className="text-sm text-muted-foreground text-center">No providers available.</p></CardContent></Card>
            ) : (
              <div className="grid gap-4">
                {filteredProviders.map((provider) => (
                  <Card key={provider.id} className="bg-card border-border">
                    <CardHeader className="p-4 pb-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="text-base">{provider.name}</CardTitle>
                          <CardDescription className="text-xs mt-1">{provider.instances.length} instance{provider.instances.length !== 1 ? 's' : ''}</CardDescription>
                        </div>
                        <div className="flex flex-wrap justify-end gap-1">
                          {provider.authMethods.map((method) => <Badge key={method.kind} variant="outline" className="text-xs">{method.label}</Badge>)}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-4 pt-0 space-y-3">
                      {provider.instances.map((instance) => (
                        <div key={instance.instanceId} className="rounded-md border border-border p-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">{instance.label}</span>
                                {statusBadge(instance)}
                              </div>
                              {instance.email && <p className="text-xs text-muted-foreground mt-1">{instance.email}</p>}
                              {instance.status.label && <p className="text-xs text-muted-foreground mt-1">Source: {instance.status.label}</p>}
                            </div>
                            <div className="flex flex-wrap gap-2 shrink-0">
                              <Button size="sm" variant={instance.status.configured ? 'outline' : 'default'} onClick={() => openLogin(provider, instance, 'edit')}>
                                {instance.status.configured ? <RefreshCw className="h-3.5 w-3.5 mr-1" /> : <Shield className="h-3.5 w-3.5 mr-1" />}
                                {instance.status.configured ? 'Reconnect' : 'Login'}
                              </Button>
                              {instance.source === 'pocketbase' && (
                                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(instance)} disabled={deleteAccountMutation.isPending}>
                                  <Trash2 className="h-3.5 w-3.5 mr-1" /> Disconnect
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      <Button size="sm" variant="outline" onClick={() => openLogin(provider, { id: provider.id, instanceId: provider.id, providerId: provider.id, label: provider.name, source: 'runtime', status: provider.authStatus }, 'add')}>
                        <Plus className="h-3.5 w-3.5 mr-1" /> Add another account
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">Custom Providers</h2>
                <p className="text-sm text-muted-foreground">Manage custom Pi-compatible provider endpoints.</p>
              </div>
              <Button size="sm" onClick={() => { setCustomProviderTarget(null); setCustomProviderDialogOpen(true) }}><Plus className="h-4 w-4 mr-1" /> Add</Button>
            </div>

            {customProviders.length === 0 ? (
              <Card className="bg-card border-border"><CardContent className="pt-6"><p className="text-sm text-muted-foreground text-center">No custom providers configured.</p></CardContent></Card>
            ) : (
              <div className="grid gap-2">
                {customProviders.map((provider) => (
                  <Card key={provider.id} className="bg-card border-border"><CardHeader className="p-3"><div className="flex items-center justify-between gap-2"><div className="min-w-0"><CardTitle className="text-sm truncate">{provider.name}</CardTitle><CardDescription className="text-xs truncate">{provider.id} · {provider.models.length} model{provider.models.length !== 1 ? 's' : ''} · {provider.api}</CardDescription></div><div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => { setCustomProviderTarget(provider); setCustomProviderDialogOpen(true) }} className="h-8 w-8 p-0"><Pencil className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" onClick={() => setCustomProviderDeleteTarget(provider.id)} disabled={deleteCustomProviderMutation.isPending} className="h-8 w-8 p-0 text-destructive hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></Button></div></div></CardHeader></Card>
                ))}
              </div>
            )}
          </section>

          {apiKeyTarget && <ApiKeyDialog open={apiKeyDialogOpen} onOpenChange={handleApiKeyDialogClose} provider={apiKeyTarget} onSuccess={handleApiKeySuccess} mode={apiKeyMode} />}
          {customProviderDialogOpen && <CustomProviderDialog key={customProviderTarget?.id ?? 'new'} open={customProviderDialogOpen} provider={customProviderTarget} onOpenChange={(open) => { setCustomProviderDialogOpen(open); if (!open) setCustomProviderTarget(null) }} onSave={(provider) => saveCustomProviderMutation.mutate(provider)} isSaving={saveCustomProviderMutation.isPending} />}

          <DeleteDialog
            open={deleteTarget !== null}
            onOpenChange={(open) => !open && setDeleteTarget(null)}
            onConfirm={() => { if (deleteTarget) deleteAccountMutation.mutate(deleteTarget.instanceId) }}
            onCancel={() => setDeleteTarget(null)}
            title="Disconnect provider account"
            description={`Are you sure you want to disconnect ${deleteTarget?.label || 'this provider account'}?`}
            isDeleting={deleteAccountMutation.isPending}
          />
          <DeleteDialog
            open={customProviderDeleteTarget !== null}
            onOpenChange={(open) => !open && setCustomProviderDeleteTarget(null)}
            onConfirm={() => customProviderDeleteTarget && deleteCustomProviderMutation.mutate(customProviderDeleteTarget)}
            onCancel={() => setCustomProviderDeleteTarget(null)}
            title="Delete Custom Provider"
            description={`Are you sure you want to delete ${customProviderDeleteTarget || 'this custom provider'}?`}
            isDeleting={deleteCustomProviderMutation.isPending}
          />
        </div>
      </TabsContent>
    </Tabs>
  )
}
