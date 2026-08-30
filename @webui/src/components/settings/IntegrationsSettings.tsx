import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Loader2, Mail, Network, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { type IntegrationConfig } from '@/api/types/settings'
import { settingsApi } from '@/api/settings'
import { showToast } from '@/lib/toast'

type IntegrationType = IntegrationConfig['type']

const integrationTypes: Record<IntegrationType, { label: string; description: string }> = {
  mcp: { label: 'MCP', description: 'Model Context Protocol server access for agent tools' },
  openapi: { label: 'OpenAPI', description: 'OpenAPI JSON operations exposed as agent tools' },
  caldav: { label: 'CalDAV', description: 'Calendar access for scheduling and availability workflows' },
  mail: { label: 'IMAP/SMTP', description: 'Email inbox and sending configuration for mail-aware agents' },
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

  if (type === 'caldav') {
    return { ...base, type, serverUrl: '', username: '', password: '', calendarUrl: '' }
  }

  return {
    ...base,
    type,
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 587,
    username: '',
    password: '',
    fromAddress: '',
  }
}

function IntegrationIcon({ type }: { type: IntegrationType }) {
  if (type === 'mcp') return <Network className="h-4 w-4 text-muted-foreground" />
  if (type === 'openapi') return <Network className="h-4 w-4 text-muted-foreground" />
  if (type === 'caldav') return <CalendarDays className="h-4 w-4 text-muted-foreground" />
  return <Mail className="h-4 w-4 text-muted-foreground" />
}

interface IntegrationDialogProps {
  open: boolean
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

function IntegrationDialog({ open, integration, isSaving, onOpenChange, onSave }: IntegrationDialogProps) {
  const [formData, setFormData] = useState<IntegrationConfig>(createIntegration('mcp'))
  const [calDavCalendars, setCalDavCalendars] = useState<Array<{ name: string; url: string; description?: string }>>([])
  const [isDiscoveringCalendars, setIsDiscoveringCalendars] = useState(false)
  const [isTestingCalDav, setIsTestingCalDav] = useState(false)
  const [discoveredTools, setDiscoveredTools] = useState<Array<{ toolId: string; method: string; path: string; description: string }>>([])
  const [isDiscoveringOpenApi, setIsDiscoveringOpenApi] = useState(false)

  useEffect(() => {
    if (!open) return
    setFormData(integration ?? createIntegration('mcp'))
    setCalDavCalendars([])
    setIsTestingCalDav(false)
    setDiscoveredTools([])
  }, [open, integration])

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

    if (formData.type === 'mcp') {
      if (formData.transport === 'stdio' && !(formData.command?.length)) {
        showToast.error('A command is required for a local MCP server')
        return
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

    await onSave(formData)
    onOpenChange(false)
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

  const discoverCalDavCalendars = async () => {
    if (formData.type !== 'caldav') return
    if (!formData.serverUrl.trim() || !formData.username.trim() || !formData.password.trim()) {
      showToast.error('Server URL, username, and password are required')
      return
    }

    setIsDiscoveringCalendars(true)
    try {
      const result = await settingsApi.discoverCalDavCalendars(formData.serverUrl, formData.username, formData.password)
      setCalDavCalendars(result.calendars)
      if (result.calendars.length === 0) {
        showToast.error('No calendars found')
        return
      }
      updateField('calendarUrl', result.calendars[0]?.url ?? '')
      showToast.success(`Found ${result.calendars.length} calendar${result.calendars.length === 1 ? '' : 's'}`)
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Failed to discover calendars')
    } finally {
      setIsDiscoveringCalendars(false)
    }
  }

  const testCalDavConnection = async () => {
    if (formData.type !== 'caldav') return
    if (!formData.serverUrl.trim() || !formData.username.trim() || !formData.password.trim()) {
      showToast.error('Server URL, username, and password are required')
      return
    }

    setIsTestingCalDav(true)
    try {
      const result = await settingsApi.discoverCalDavCalendars(formData.serverUrl, formData.username, formData.password)
      setCalDavCalendars(result.calendars)
      if (result.calendars.length === 0) {
        showToast.error('Connected, but no calendars were found')
        return
      }
      if (!formData.calendarUrl) {
        updateField('calendarUrl', result.calendars[0]?.url ?? '')
      }
      showToast.success(`CalDAV connection works. Found ${result.calendars.length} calendar${result.calendars.length === 1 ? '' : 's'}`)
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'CalDAV connection failed')
    } finally {
      setIsTestingCalDav(false)
    }
  }

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
                  <SelectItem value="caldav">CalDAV</SelectItem>
                  <SelectItem value="mail">IMAP/SMTP</SelectItem>
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
                    <Input id="mcp-command" className="font-mono" placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp" value={(formData.command ?? []).join(' ')} onChange={(event) => updateField('command', event.target.value.split(' ').filter(Boolean))} disabled={isSaving} />
                    <p className="text-xs text-muted-foreground">Runs directly as argv; shell syntax is not interpreted.</p>
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

            {formData.type === 'caldav' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="caldav-server-url">Server URL</Label>
                  <Input id="caldav-server-url" placeholder="https://caldav.example.com" value={formData.serverUrl} onChange={(event) => updateField('serverUrl', event.target.value)} disabled={isSaving} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="caldav-username">Username</Label>
                  <Input id="caldav-username" value={formData.username} onChange={(event) => updateField('username', event.target.value)} disabled={isSaving} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="caldav-password">Password</Label>
                  <Input id="caldav-password" type="password" value={formData.password} onChange={(event) => updateField('password', event.target.value)} disabled={isSaving} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="caldav-calendar-url">Calendar</Label>
                    <Button type="button" variant="outline" size="sm" onClick={discoverCalDavCalendars} disabled={isSaving || isDiscoveringCalendars}>
                      {isDiscoveringCalendars && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      Discover
                    </Button>
                  </div>
                  {calDavCalendars.length > 0 ? (
                    <Select value={formData.calendarUrl} onValueChange={(value) => updateField('calendarUrl', value)} disabled={isSaving}>
                      <SelectTrigger id="caldav-calendar-url">
                        <SelectValue placeholder="Select a calendar" />
                      </SelectTrigger>
                      <SelectContent>
                        {calDavCalendars.map((calendar) => (
                          <SelectItem key={calendar.url} value={calendar.url}>{calendar.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input id="caldav-calendar-url" value={formData.calendarUrl} onChange={(event) => updateField('calendarUrl', event.target.value)} disabled={isSaving} placeholder="Discover from server response" />
                  )}
                </div>
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div>
                    <h3 className="font-medium text-foreground">Test CalDAV</h3>
                    <p className="text-sm text-muted-foreground">Verify the server URL and credentials by discovering calendars from the CalDAV response.</p>
                  </div>
                  <Button type="button" variant="outline" onClick={testCalDavConnection} disabled={isSaving || isTestingCalDav}>
                    {isTestingCalDav && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                    Test Connection
                  </Button>
                </div>
              </>
            )}

            {formData.type === 'mail' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="mail-imap-host">IMAP Host</Label>
                    <Input id="mail-imap-host" placeholder="imap.example.com" value={formData.imapHost} onChange={(event) => updateField('imapHost', event.target.value)} disabled={isSaving} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mail-imap-port">IMAP Port</Label>
                    <Input id="mail-imap-port" type="number" min={1} max={65535} value={formData.imapPort} onChange={(event) => updateField('imapPort', Number(event.target.value) || 993)} disabled={isSaving} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mail-smtp-host">SMTP Host</Label>
                    <Input id="mail-smtp-host" placeholder="smtp.example.com" value={formData.smtpHost} onChange={(event) => updateField('smtpHost', event.target.value)} disabled={isSaving} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mail-smtp-port">SMTP Port</Label>
                    <Input id="mail-smtp-port" type="number" min={1} max={65535} value={formData.smtpPort} onChange={(event) => updateField('smtpPort', Number(event.target.value) || 587)} disabled={isSaving} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mail-username">Username</Label>
                  <Input id="mail-username" value={formData.username} onChange={(event) => updateField('username', event.target.value)} disabled={isSaving} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mail-password">Password</Label>
                  <Input id="mail-password" type="password" value={formData.password} onChange={(event) => updateField('password', event.target.value)} disabled={isSaving} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mail-from-address">From Address</Label>
                  <Input id="mail-from-address" type="email" placeholder="agent@example.com" value={formData.fromAddress} onChange={(event) => updateField('fromAddress', event.target.value)} disabled={isSaving} />
                </div>
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
  const [testingCalDavIntegrationId, setTestingCalDavIntegrationId] = useState<string | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['integrations'],
    queryFn: settingsApi.listIntegrations,
  })

  const integrations = useMemo(() => data?.integrations ?? [], [data?.integrations])
  const refreshIntegrations = () => queryClient.invalidateQueries({ queryKey: ['integrations'] })

  const createMutation = useMutation({
    mutationFn: settingsApi.createIntegration,
    onSuccess: refreshIntegrations,
  })

  const updateMutation = useMutation({
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

  const openAddDialog = () => {
    setEditingIntegrationId(null)
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

  const testCalDavIntegration = async (integration: IntegrationConfig) => {
    if (integration.type !== 'caldav') return
    if (!integration.serverUrl.trim() || !integration.username.trim() || !integration.password.trim()) {
      showToast.error('Server URL, username, and password are required')
      return
    }

    setTestingCalDavIntegrationId(integration.id)
    try {
      const result = await settingsApi.discoverCalDavCalendars(integration.serverUrl, integration.username, integration.password)
      if (result.calendars.length === 0) {
        showToast.error('Connected, but no calendars were found')
        return
      }
      showToast.success(`CalDAV connection works. Found ${result.calendars.length} calendar${result.calendars.length === 1 ? '' : 's'}`)
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'CalDAV connection failed')
    } finally {
      setTestingCalDavIntegrationId(null)
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
          <p className="text-sm text-muted-foreground">Configure external services agents can use.</p>
        </div>
        <Button type="button" size="sm" onClick={openAddDialog}>
          <Plus className="h-4 w-4 mr-2" />
          Add Integration
        </Button>
      </div>

      <div className="mt-6">
        {integrations.length === 0 ? (
          <div className="rounded-lg border  text-center">
            <Network className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-medium text-foreground mb-1">No integrations configured</h3>
            <p className="text-sm text-muted-foreground mb-4">Add MCP, CalDAV, or IMAP/SMTP connections for agents to use.</p>
            <Button type="button" onClick={openAddDialog}>
              <Plus className="h-4 w-4 mr-2" />
              Add Integration
            </Button>
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
                {integration.type === 'caldav' && (
                  <Button type="button" variant="outline" size="sm" onClick={() => testCalDavIntegration(integration)} disabled={isUpdating || testingCalDavIntegrationId === integration.id}>
                    {testingCalDavIntegrationId === integration.id && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                    Test
                  </Button>
                )}
                <Switch checked={integration.enabled} onCheckedChange={(checked) => toggleIntegration(integration.id, checked)} disabled={isUpdating} />
                <Button type="button" variant="ghost" size="icon" onClick={() => openEditDialog(integration.id)} disabled={isUpdating}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" onClick={() => removeIntegration(integration.id)} disabled={isUpdating}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <IntegrationDialog
        open={isDialogOpen}
        integration={editingIntegration}
        isSaving={isUpdating}
        onOpenChange={setIsDialogOpen}
        onSave={saveIntegration}
      />
    </div>
  )
}
