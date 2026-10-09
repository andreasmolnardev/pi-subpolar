import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Github, GripVertical, Loader2, Network, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { settingsApi } from '@/api/settings'
import { formatMcpCommand, parseMcpCommand } from '@/api/mcp'
import { showToast } from '@/lib/toast'
import { GitProviderAccountsSettings } from './GitProviderAccountsSettings'

type IntegrationBase = {
  id: string
  name: string
  enabled: boolean
}

type IntegrationConfig =
  | (IntegrationBase & {
      type: 'mcp'
      transport: 'stdio' | 'streamable-http'
      serverUrl: string
      command: string[]
      cwd: string
      environment: Record<string, string>
      headers: Record<string, string>
      timeout: number
    })
  | (IntegrationBase & {
      type: 'openapi'
      providerName: string
      document: string
      serverUrl: string
      timeout: number
      authType: 'spec' | 'none' | 'apiKey' | 'bearer' | 'basic' | 'headers'
      authKeyName: string
      authPlacement: 'header' | 'query' | 'cookie'
      authValue: string
      authUsername: string
      authPassword: string
      headers: Record<string, string>
    })
  | (IntegrationBase & {
      type: 'web-search'
      providers: Array<'exa' | 'duckduckgo' | 'firecrawl' | 'parallel'>
    })

type IntegrationType = IntegrationConfig['type']

const integrationTypes: Record<IntegrationType, { label: string; description: string }> = {
  mcp: { label: 'MCP', description: 'Model Context Protocol server access for agent tools' },
  openapi: { label: 'OpenAPI', description: 'OpenAPI JSON operations exposed as agent tools' },
  'web-search': { label: 'Web Search', description: 'Exa, DuckDuckGo, and Firecrawl providers for the web.search agent tool' },
}

function createIntegration(type: IntegrationType): IntegrationConfig {
  const base = {
    id: crypto.randomUUID(),
    name: integrationTypes[type].label,
    enabled: true,
  }

  if (type === 'mcp') {
    return { ...base, type, transport: 'streamable-http', serverUrl: '', command: [], cwd: '', environment: {}, headers: {}, timeout: 15000 }
  }

  if (type === 'openapi') {
    return { ...base, type, providerName: 'api', document: '{\n  "openapi": "3.0.0",\n  "info": { "title": "API", "version": "1.0.0" },\n  "servers": [{ "url": "https://api.example.com" }],\n  "paths": {}\n}', serverUrl: '', timeout: 15000, authType: 'spec', authKeyName: '', authPlacement: 'header', authValue: '', authUsername: '', authPassword: '', headers: {} }
  }


  return { ...base, id: 'web-search', name: 'Web Search', type, providers: ['exa', 'firecrawl'] }
}

function IntegrationIcon({ type }: { type: IntegrationType }) {
  if (type === 'mcp') return <Network className="h-4 w-4 text-muted-foreground" />
  if (type === 'openapi') return <Network className="h-4 w-4 text-muted-foreground" />
  if (type === 'web-search') return <Search className="h-4 w-4 text-muted-foreground" />
  return <Network className="h-4 w-4 text-muted-foreground" />
}

interface IntegrationDialogProps {
  open: boolean
  initialType: 'mcp' | 'openapi'
  integration?: IntegrationConfig
  isSaving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (integration: IntegrationConfig) => Promise<void>
}

interface McpKeyValueFieldsProps {
  label: string
  description: string
  values: Record<string, string>
  disabled: boolean
  onChange: (values: Record<string, string>) => void
}

function McpKeyValueFields({ label, description, values, disabled, onChange }: McpKeyValueFieldsProps) {
  const entries = Object.entries(values)
  const update = (previousKey: string, key: string, value: string) => {
    const next = { ...values }
    delete next[previousKey]
    if (key.trim()) next[key.trim()] = value
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>{label}</Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...values, [`NEW_${entries.length + 1}`]: '' })} disabled={disabled}>Add</Button>
      </div>
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <Input className="font-mono" value={key} onChange={(event) => update(key, event.target.value, value)} disabled={disabled} placeholder="NAME" />
          <Input className="font-mono" type="password" value={value} onChange={(event) => update(key, key, event.target.value)} disabled={disabled} placeholder="Value" />
          <Button type="button" variant="outline" size="icon" onClick={() => update(key, '', '')} disabled={disabled}>×</Button>
        </div>
      ))}
    </div>
  )
}

function IntegrationDialog({ open, initialType, integration, isSaving, onOpenChange, onSave }: IntegrationDialogProps) {
  const [formData, setFormData] = useState<IntegrationConfig>(createIntegration('mcp'))
  const [commandText, setCommandText] = useState('[]')
  const [discoveredTools, setDiscoveredTools] = useState<Array<{ toolId: string; method: string; path: string; description: string }>>([])
  const [isDiscoveringOpenApi, setIsDiscoveringOpenApi] = useState(false)
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Partial<Record<'exa' | 'firecrawl' | 'parallel', string>>>({})
  const [showApiKey, setShowApiKey] = useState<Partial<Record<'exa' | 'firecrawl' | 'parallel', boolean>>>({})
  const [deleteApiKey, setDeleteApiKey] = useState<Partial<Record<'exa' | 'firecrawl' | 'parallel', boolean>>>({})
  const [draggingProvider, setDraggingProvider] = useState<string | null>(null)
  const credentialStatus = useQuery({
    queryKey: ['web-search-credential-status'],
    queryFn: settingsApi.getWebSearchCredentialStatus,
    enabled: open && formData.type === 'web-search',
  })

  useEffect(() => {
    if (!open) return
    setFormData(integration ?? createIntegration(initialType))
    setCommandText(formatMcpCommand(integration?.type === 'mcp' ? integration.command : []))
    setDiscoveredTools([])
    setApiKeyDrafts({})
    setShowApiKey({})
    setDeleteApiKey({})
  }, [open, initialType, integration])

  const updateField = (field: string, value: string | number | boolean | string[] | Record<string, string> | undefined) => {
    setFormData((current) => ({ ...current, [field]: value } as IntegrationConfig))
  }

  const changeType = (type: IntegrationType) => {
    setFormData((current) => ({ ...createIntegration(type), id: current.id, name: current.name }))
  }

  const handleSubmit = async () => {
    if (!formData.name.trim()) {
      showToast.error('Name is required')
      return
    }

    let integrationToSave = formData
    if (formData.type === 'mcp') {
      if (formData.transport === 'stdio') {
        try {
          integrationToSave = { ...formData, command: parseMcpCommand(commandText) }
        } catch (error) {
          showToast.error(error instanceof Error ? error.message : 'Invalid MCP command')
          return
        }
      }

      if (formData.transport === 'streamable-http' && !formData.serverUrl?.trim()) {
        showToast.error('A server URL is required for a remote MCP server')
        return
      }
    }

    if (formData.type === 'openapi' && !formData.providerName.trim()) {
      showToast.error('Provider name is required')
      return
    }

    try {
      await onSave(integrationToSave)
      if (formData.type === 'web-search') {
        const drafts = Object.fromEntries(Object.entries(apiKeyDrafts).filter(([provider, value]) => value?.trim() && !deleteApiKey[provider as 'exa' | 'firecrawl' | 'parallel'])) as Partial<Record<'exa' | 'firecrawl' | 'parallel', string>>
        if (Object.keys(drafts).length) await settingsApi.saveWebSearchCredentials(drafts)
        for (const provider of Object.keys(deleteApiKey) as Array<'exa' | 'firecrawl' | 'parallel'>) {
          if (deleteApiKey[provider]) await settingsApi.deleteWebSearchCredential(provider)
        }
        if (Object.keys(drafts).length || Object.values(deleteApiKey).some(Boolean)) await credentialStatus.refetch()
      }
      onOpenChange(false)
    } catch {
      showToast.error('Failed to save web search credentials')
    }
  }

  const discoverOpenApi = async () => {
    if (formData.type !== 'openapi') return
    setIsDiscoveringOpenApi(true)
    try {
      const result = await settingsApi.discoverOpenApi(formData)
      setDiscoveredTools(result.tools)
      showToast.success(`Found ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}`)
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'OpenAPI discovery failed')
    } finally { setIsDiscoveringOpenApi(false) }
  }

  const webSearchProviderOrder = formData.type === 'web-search'
    ? [...formData.providers, ...(['exa', 'duckduckgo', 'firecrawl', 'parallel'] as const).filter((provider) => !formData.providers.includes(provider))]
    : []


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent mobileFullscreen className="max-w-lg h-[90vh] sm:h-auto sm:max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-2 sm:pb-3">
          <DialogTitle>{integration ? 'Edit Integration' : 'Add Integration'}</DialogTitle>
        </DialogHeader>

        <form
          onSubmit={(event) => { event.preventDefault(); handleSubmit() }}
          className="flex-1 min-h-0 flex flex-col px-4 sm:px-6 py-2 sm:py-3 overflow-y-auto"
        >
          <div className="space-y-4 flex-shrink-0">
            <div className="space-y-2">
              <Label htmlFor="integration-type">Type</Label>
              <Select value={formData.type} onValueChange={(value) => changeType(value as IntegrationType)} disabled={Boolean(integration) || isSaving}>
                <SelectTrigger id="integration-type">
                  <SelectValue />
                </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mcp">MCP</SelectItem>
                    <SelectItem value="openapi">OpenAPI</SelectItem>
                    <SelectItem value="web-search" disabled>Web Search (built-in)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="integration-name">Name *</Label>
              <Input id="integration-name" value={formData.name} onChange={(event) => updateField('name', event.target.value)} disabled={isSaving} />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <Label htmlFor="integration-enabled">Enabled</Label>
              <Switch id="integration-enabled" checked={formData.enabled} onCheckedChange={(checked) => updateField('enabled', checked)} disabled={isSaving} />
            </div>

            {formData.type === 'web-search' && (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-sm text-muted-foreground">Enabled providers are tried in order and the next provider is used if one is unavailable. Drag providers to change priority. DuckDuckGo scrapes public results and does not use an API key.</p>
                {webSearchProviderOrder.map((provider) => {
                  const enabled = formData.providers.includes(provider)
                  const name = provider === 'exa' ? 'Exa' : provider === 'duckduckgo' ? 'DuckDuckGo' : provider === 'firecrawl' ? 'Firecrawl' : 'Parallel'
                  const supportsKey = provider !== 'duckduckgo'
                  const configured = provider === 'duckduckgo' ? false : credentialStatus.data?.configured[provider]
                  return (
                    <div key={provider} className="space-y-2">
                      <div
                        className={`flex items-center justify-between gap-3 rounded-md px-1 py-1 ${draggingProvider === provider ? 'opacity-50' : ''}`}
                        draggable={enabled && !isSaving}
                        onDragStart={() => setDraggingProvider(provider)}
                        onDragEnd={() => setDraggingProvider(null)}
                        onDragOver={(event) => { if (draggingProvider && enabled) event.preventDefault() }}
                        onDrop={(event) => {
                          event.preventDefault()
                          if (!draggingProvider || !enabled || draggingProvider === provider) return
                          const next = [...formData.providers]
                          const from = next.indexOf(draggingProvider as typeof provider)
                          const to = next.indexOf(provider)
                          if (from >= 0 && to >= 0) {
                            const [moved] = next.splice(from, 1)
                            next.splice(to, 0, moved!)
                            updateField('providers', next)
                          }
                          setDraggingProvider(null)
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <GripVertical className={`h-4 w-4 shrink-0 ${enabled ? 'cursor-grab text-muted-foreground' : 'text-muted-foreground/40'}`} aria-label={enabled ? `Drag ${name} to change priority` : undefined} />
                          <div className="min-w-0">
                            <Label htmlFor={`web-search-${provider}`}>{name}{provider === 'duckduckgo' ? '' : ' MCP'}</Label>
                            <p className="text-xs text-muted-foreground">{provider === 'duckduckgo' ? 'Keyless HTML scraping; experimental' : configured ? 'API key saved' : 'Optional API key; free tier available'}</p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {supportsKey && (
                            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`${configured ? 'Replace' : 'Add'} ${name} API key`} onClick={() => setShowApiKey((current) => ({ ...current, [provider]: !current[provider] }))} disabled={isSaving}>
                              <Plus className="h-4 w-4" />
                            </Button>
                          )}
                          <Switch
                            id={`web-search-${provider}`}
                            checked={enabled}
                            onCheckedChange={(checked) => updateField('providers', checked
                              ? [...formData.providers.filter((item) => item !== provider), provider]
                              : formData.providers.filter((item) => item !== provider))}
                            disabled={isSaving || !formData.enabled}
                          />
                        </div>
                      </div>
                      {supportsKey && showApiKey[provider] && (
                        <div className="ml-6 flex items-center gap-2">
                          <Input type="password" autoComplete="new-password" value={apiKeyDrafts[provider] ?? ''} onChange={(event) => setApiKeyDrafts((current) => ({ ...current, [provider]: event.target.value }))} placeholder={configured ? 'Enter a new key to replace the saved key' : `${name} API key`} disabled={isSaving} />
                          {configured && <Button type="button" variant={deleteApiKey[provider] ? 'destructive' : 'outline'} size="icon" className="h-9 w-9 shrink-0" aria-label={deleteApiKey[provider] ? `Keep ${name} API key` : `Remove ${name} API key`} onClick={() => setDeleteApiKey((current) => ({ ...current, [provider]: !current[provider] }))} disabled={isSaving}><X className="h-4 w-4" /></Button>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {formData.type === 'mcp' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="mcp-transport">Transport</Label>
                  <Select value={formData.transport} onValueChange={(value) => updateField('transport', value)} disabled={isSaving}>
                    <SelectTrigger id="mcp-transport"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="streamable-http">Remote Streamable HTTP</SelectItem>
                      <SelectItem value="stdio">Local command (stdio)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {formData.transport === 'stdio' ? <>
                  <div className="space-y-2">
                    <Label htmlFor="mcp-command">Command and arguments</Label>
                    <Input
                      id="mcp-command"
                      className="font-mono"
                      placeholder='["bun", "x", "@modelcontextprotocol/server-filesystem", "/tmp"]'
                      value={commandText}
                      onChange={(event) => {
                        setCommandText(event.target.value)
                        try { updateField('command', parseMcpCommand(event.target.value)) } catch { /* Keep the draft while it is incomplete. */ }
                      }}
                      disabled={isSaving}
                    />
                    <p className="text-xs text-muted-foreground">Enter a JSON argv array to preserve spaces; shell syntax is not interpreted.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mcp-cwd">Working directory</Label>
                    <Input id="mcp-cwd" placeholder="Optional" value={formData.cwd ?? ''} onChange={(event) => updateField('cwd', event.target.value)} disabled={isSaving} />
                  </div>
                </> : <div className="space-y-2">
                  <Label htmlFor="mcp-server-url">Server URL</Label>
                  <Input id="mcp-server-url" className="font-mono" placeholder="https://mcp.example.com/mcp" value={formData.serverUrl ?? ''} onChange={(event) => updateField('serverUrl', event.target.value)} disabled={isSaving} />
                </div>}
                <McpKeyValueFields label="Environment variables" description="Available only to the local MCP process." values={formData.environment ?? {}} onChange={(environment) => updateField('environment', environment)} disabled={isSaving || formData.transport !== 'stdio'} />
                <McpKeyValueFields label="HTTP headers" description="Sent with every remote MCP request. Values are write-only." values={formData.headers ?? {}} onChange={(headers) => updateField('headers', headers)} disabled={isSaving || formData.transport !== 'streamable-http'} />
                <div className="space-y-2">
                  <Label htmlFor="mcp-timeout">Request timeout (ms)</Label>
                  <Input id="mcp-timeout" type="number" min={1000} max={120000} value={formData.timeout ?? 15000} onChange={(event) => updateField('timeout', Number(event.target.value) || 15000)} disabled={isSaving} />
                </div>
              </>
            )}

            {formData.type === 'openapi' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="openapi-provider-name">Provider name</Label>
                  <Input id="openapi-provider-name" value={formData.providerName} onChange={(event) => updateField('providerName', event.target.value)} disabled={isSaving} placeholder="github" />
                  <p className="text-xs text-muted-foreground">Tool IDs use toolName.subtool.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="openapi-document">OpenAPI JSON</Label>
                  <Textarea id="openapi-document" className="min-h-52 font-mono text-xs" value={formData.document} onChange={(event) => updateField('document', event.target.value)} disabled={isSaving} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="openapi-server-url">Server URL override</Label>
                  <Input id="openapi-server-url" className="font-mono" value={formData.serverUrl ?? ''} onChange={(event) => updateField('serverUrl', event.target.value)} disabled={isSaving} placeholder="Use the document server" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Auth type</Label>
                    <Select value={formData.authType ?? 'spec'} onValueChange={(value) => updateField('authType', value)} disabled={isSaving}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="spec">Use specification default</SelectItem><SelectItem value="none">None</SelectItem><SelectItem value="apiKey">API key</SelectItem><SelectItem value="bearer">Bearer token</SelectItem><SelectItem value="basic">Basic auth</SelectItem><SelectItem value="headers">Custom headers</SelectItem></SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2"><Label htmlFor="openapi-timeout">Request timeout (ms)</Label><Input id="openapi-timeout" type="number" min={1000} max={120000} value={formData.timeout ?? 15000} onChange={(event) => updateField('timeout', Number(event.target.value) || 15000)} disabled={isSaving} /></div>
                </div>
                {formData.authType === 'apiKey' && <div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label>Key name</Label><Input value={formData.authKeyName ?? ''} onChange={(event) => updateField('authKeyName', event.target.value)} disabled={isSaving} /></div><div className="space-y-2"><Label>Placement</Label><Select value={formData.authPlacement ?? 'header'} onValueChange={(value) => updateField('authPlacement', value)} disabled={isSaving}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="header">Header</SelectItem><SelectItem value="query">Query</SelectItem><SelectItem value="cookie">Cookie</SelectItem></SelectContent></Select></div><div className="space-y-2 col-span-2"><Label>API key</Label><Input type="password" value={formData.authValue ?? ''} onChange={(event) => updateField('authValue', event.target.value)} disabled={isSaving} /></div></div>}
                {formData.authType === 'bearer' && <div className="space-y-2"><Label>Bearer token</Label><Input type="password" value={formData.authValue ?? ''} onChange={(event) => updateField('authValue', event.target.value)} disabled={isSaving} /></div>}
                {formData.authType === 'basic' && <div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label>Username</Label><Input value={formData.authUsername ?? ''} onChange={(event) => updateField('authUsername', event.target.value)} disabled={isSaving} /></div><div className="space-y-2"><Label>Password</Label><Input type="password" value={formData.authPassword ?? ''} onChange={(event) => updateField('authPassword', event.target.value)} disabled={isSaving} /></div></div>}
                <McpKeyValueFields label="Custom headers" description="Values are write-only." values={formData.headers ?? {}} onChange={(headers) => updateField('headers', headers)} disabled={isSaving} />
                <div className="rounded-lg border p-3 space-y-2"><Button type="button" variant="outline" onClick={discoverOpenApi} disabled={isSaving || isDiscoveringOpenApi}>{isDiscoveringOpenApi && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Discover tools</Button>{discoveredTools.length > 0 && <div className="max-h-40 overflow-y-auto space-y-1 text-xs">{discoveredTools.map((tool) => <div key={tool.toolId} className="font-mono">{tool.toolId} · {tool.method.toUpperCase()} {tool.path}</div>)}</div>}</div>
              </>
            )}

          </div>
        </form>

        <DialogFooter className="flex-shrink-0 px-4 sm:px-6 pb-4 sm:pb-6 pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>Cancel</Button>
          <Button type="button" onClick={handleSubmit} disabled={isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Save Integration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function IntegrationsSettings() {
  const queryClient = useQueryClient()
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingIntegrationId, setEditingIntegrationId] = useState<string | null>(null)
  const [showGitSettings, setShowGitSettings] = useState(false)
  const [newIntegrationType, setNewIntegrationType] = useState<'mcp' | 'openapi'>('mcp')
  const { data, isLoading } = useQuery<{ integrations: IntegrationConfig[] }>({
    queryKey: ['integrations'],
    queryFn: settingsApi.listIntegrations,
  })

  const integrations = useMemo(
    () => (data?.integrations ?? []).filter((integration) => integration.type === 'mcp' || integration.type === 'openapi' || integration.type === 'web-search'),
    [data?.integrations]
  )
  const refreshIntegrations = () => queryClient.invalidateQueries({ queryKey: ['integrations'] })

  const createMutation = useMutation<IntegrationConfig, Error, IntegrationConfig>({
    mutationFn: settingsApi.createIntegration,
    onSuccess: refreshIntegrations,
  })

  const updateMutation = useMutation<IntegrationConfig, Error, IntegrationConfig>({
    mutationFn: settingsApi.updateIntegration,
    onSuccess: refreshIntegrations,
  })

  const deleteMutation = useMutation({
    mutationFn: settingsApi.deleteIntegration,
    onSuccess: refreshIntegrations,
  })

  const isUpdating = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending

  const editingIntegration = useMemo(
    () => integrations.find((integration) => integration.id === editingIntegrationId),
    [editingIntegrationId, integrations]
  )

  const openAddDialog = (type: 'mcp' | 'openapi') => {
    setEditingIntegrationId(null)
    setNewIntegrationType(type)
    setIsDialogOpen(true)
  }

  const openEditDialog = (id: string) => {
    setEditingIntegrationId(id)
    setIsDialogOpen(true)
  }

  const saveIntegration = async (integration: IntegrationConfig) => {
    const exists = integrations.some((item) => item.id === integration.id)

    try {
      if (exists) {
        await updateMutation.mutateAsync(integration)
        showToast.success('Integration updated')
      } else {
        await createMutation.mutateAsync(integration)
        showToast.success('Integration added')
      }
    } catch {
      showToast.error('Failed to save integration')
    }
  }

  const removeIntegration = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id)
      showToast.success('Integration deleted')
    } catch {
      showToast.error('Failed to delete integration')
    }
  }

  const toggleIntegration = async (id: string, enabled: boolean) => {
    const integration = integrations.find((item) => item.id === id)
    if (!integration) return

    try {
      await updateMutation.mutateAsync({ ...integration, enabled })
      showToast.success(enabled ? 'Integration enabled' : 'Integration disabled')
    } catch {
      showToast.error('Failed to update integration')
    }
  }


  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Integrations</h2>
          <p className="text-sm text-muted-foreground">Configure external services agents can use, including Git provider accounts.</p>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" size="sm"><Plus className="h-4 w-4 mr-2" />Add integration</Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48 p-1">
            <Button type="button" variant="ghost" className="w-full justify-start" onClick={() => setShowGitSettings(true)}><Github className="mr-2 h-4 w-4" />Git</Button>
            <Button type="button" variant="ghost" className="w-full justify-start" onClick={() => openAddDialog('mcp')}><Network className="mr-2 h-4 w-4" />MCP</Button>
            <Button type="button" variant="ghost" className="w-full justify-start" onClick={() => openAddDialog('openapi')}><Network className="mr-2 h-4 w-4" />OpenAPI</Button>
          </PopoverContent>
        </Popover>
      </div>

      <div className="mt-6">
        {showGitSettings && <GitProviderAccountsSettings />}
        {integrations.length === 0 ? (
          <div className="rounded-lg border  text-center">
            <Network className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-medium text-foreground mb-1">No integrations configured</h3>
            <p className="text-sm text-muted-foreground mb-4">Add MCP or OpenAPI connections for agents to use.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {integrations.map((integration) => (
              <div key={integration.id} className="flex items-center gap-3 rounded-lg border border-border p-4">
                <div className="p-2 rounded-md bg-accent">
                  <IntegrationIcon type={integration.type} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-foreground truncate">{integration.name}</h3>
                    <span className="text-xs rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{integrationTypes[integration.type].label}</span>
                  </div>
                  <p className="text-sm text-muted-foreground truncate">{integrationTypes[integration.type].description}</p>
                </div>
                <Switch checked={integration.enabled} onCheckedChange={(checked) => toggleIntegration(integration.id, checked)} disabled={isUpdating} />
                <Button type="button" variant="ghost" size="icon" onClick={() => openEditDialog(integration.id)} disabled={isUpdating}>
                  <Pencil className="h-4 w-4" />
                </Button>
                {integration.type !== 'web-search' && (
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeIntegration(integration.id)} disabled={isUpdating}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <IntegrationDialog
        open={isDialogOpen}
        initialType={newIntegrationType}
        integration={editingIntegration}
        isSaving={isUpdating}
        onOpenChange={setIsDialogOpen}
        onSave={saveIntegration}
      />
    </div>
  )
}
