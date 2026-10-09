import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Bot, Clock3, Copy, Play, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { API_BASE_URL } from '@/config'
import { settingsApi } from '@/api/settings'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Header } from '@/components/ui/header'
import { showToast } from '@/lib/toast'
import {
  SubpolarClient,
  type AutomationAction,
  type AutomationDefinition,
  type AutomationExecution,
  type AutomationTrigger,
  type CreateAutomationInput,
  type ManagedWebhookCredential,
} from '@subpolar/client'

const client = new SubpolarClient(API_BASE_URL)
const automationQueryKey = ['subpolar', 'automations']

type TriggerType = AutomationTrigger['type']
type ActionType = AutomationAction['type']

function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.type === 'manual') return 'Manual'
  if (trigger.type === 'schedule') return `Schedule · ${trigger.cron} (${trigger.timezone})`
  if (trigger.type === 'webhook') return 'Webhook'
  return `Event · ${trigger.eventType}`
}

function statusTone(status?: string | null): string {
  if (status === 'completed') return 'text-emerald-500'
  if (status === 'failed' || status === 'unknown' || status === 'interrupted') return 'text-destructive'
  if (status === 'running' || status === 'pending' || status === 'processing_output') return 'text-primary'
  return 'text-muted-foreground'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function FirstClassAutomations() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<AutomationDefinition | null>(null)
  const [webhookCredential, setWebhookCredential] = useState<ManagedWebhookCredential | null>(null)
  const automationsQuery = useQuery({
    queryKey: automationQueryKey,
    queryFn: async () => (await client.listAutomations()).automations,
    refetchInterval: 10_000,
  })
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: () => settingsApi.listAgents() })
  const selected = automationsQuery.data?.find((automation) => automation.id === selectedId) ?? automationsQuery.data?.[0]
  const executionsQuery = useQuery({
    queryKey: [...automationQueryKey, selected?.id, 'executions'],
    queryFn: async () => (await client.listExecutions(selected!.id, { limit: 25 })).executions,
    enabled: Boolean(selected?.id),
    refetchInterval: 5000,
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: automationQueryKey })
  const createMutation = useMutation({
    mutationFn: async (input: CreateAutomationInput) => {
      const result = await client.createAutomation(input)
      if (result.webhook) setWebhookCredential(result.webhook)
      return result.automation
    },
    onSuccess: (automation) => {
      setSelectedId(automation.id)
      setEditorOpen(false)
      setEditing(null)
      refresh()
      showToast.success('Automation created')
    },
    onError: (error) => showToast.error(`Could not create automation: ${errorText(error)}`),
  })
  const updateMutation = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: CreateAutomationInput }) => {
      const result = await client.updateAutomation(id, input)
      if (result.webhook) setWebhookCredential(result.webhook)
      return result.automation
    },
    onSuccess: (automation) => {
      setSelectedId(automation.id)
      setEditorOpen(false)
      setEditing(null)
      refresh()
      showToast.success('Automation updated')
    },
    onError: (error) => showToast.error(`Could not update automation: ${errorText(error)}`),
  })
  const runMutation = useMutation({
    mutationFn: (id: string) => client.runAutomation(id),
    onSuccess: ({ execution }) => {
      setSelectedId(execution.automationId)
      refresh()
      queryClient.invalidateQueries({ queryKey: [...automationQueryKey, execution.automationId, 'executions'] })
      showToast.success('Automation started')
    },
    onError: (error) => showToast.error(`Could not run automation: ${errorText(error)}`),
  })
  const setEnabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => enabled ? client.enableAutomation(id) : client.disableAutomation(id),
    onSuccess: refresh,
    onError: (error) => showToast.error(`Could not update automation: ${errorText(error)}`),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.deleteAutomation(id),
    onSuccess: () => {
      setSelectedId(null)
      refresh()
      showToast.success('Automation deleted')
    },
    onError: (error) => showToast.error(`Could not delete automation: ${errorText(error)}`),
  })
  const rotateWebhookMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await client.rotateWebhookSecret(id)
      setWebhookCredential(response.webhook)
      return true
    },
    onError: (error) => showToast.error(`Could not rotate webhook secret: ${errorText(error)}`),
  })

  const openCreate = () => { setEditing(null); setEditorOpen(true) }
  const openEdit = () => { if (selected) { setEditing(selected); setEditorOpen(true) } }

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background">
      <Header>
        <Header.Title>Automations</Header.Title>
        <Header.Actions>
          <Button variant="outline" onClick={() => void refresh()} aria-label="Refresh automations"><RefreshCw className="h-4 w-4" /></Button>
          <Button onClick={openCreate}><Plus className="h-4 w-4" />New automation</Button>
        </Header.Actions>
      </Header>

      <main className="mx-auto grid w-full max-w-7xl flex-1 min-h-0 grid-cols-1 gap-4 overflow-auto p-4 pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.4fr)] lg:pb-4">
        <section className="min-h-0 rounded-xl border bg-card">
          <div className="border-b px-4 py-3"><h2 className="font-semibold">Your automations</h2><p className="text-sm text-muted-foreground">Each workflow runs through its selected Subpolar agent.</p></div>
          {automationsQuery.isLoading ? <div className="p-6 text-sm text-muted-foreground">Loading automations…</div> : null}
          {automationsQuery.isError ? <div className="p-6 text-sm text-destructive">{errorText(automationsQuery.error)}</div> : null}
          {automationsQuery.data?.length === 0 ? <div className="p-6 text-sm text-muted-foreground">No automations yet. Create one to get started.</div> : null}
          <div className="divide-y">
            {automationsQuery.data?.map((automation) => (
              <button key={automation.id} type="button" onClick={() => setSelectedId(automation.id)} className={`w-full px-4 py-4 text-left transition-colors hover:bg-accent/50 ${automation.id === selected?.id ? 'bg-accent/60' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{automation.name}</div>
                    <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground"><Bot className="h-3.5 w-3.5" />{agentName(agentsQuery.data, automation.agentId)}</div>
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{triggerLabel(automation.trigger)}</div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${automation.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{automation.enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>Last run {automation.lastExecutionAt ? new Date(automation.lastExecutionAt).toLocaleString() : 'Never'}</span>
                  <span className={statusTone(automation.lastStatus)}>{automation.lastStatus ?? 'No runs'}</span>
                </div>
                {automation.nextExecutionAt && <div className="mt-1 text-xs text-muted-foreground">Next {new Date(automation.nextExecutionAt).toLocaleString()}</div>}
              </button>
            ))}
          </div>
        </section>

        <section className="min-h-0 rounded-xl border bg-card">
          {selected ? <>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4">
              <div className="min-w-0"><h2 className="truncate text-lg font-semibold">{selected.name}</h2><p className="mt-1 text-sm text-muted-foreground">{selected.description || triggerLabel(selected.trigger)} · Agent: {agentName(agentsQuery.data, selected.agentId)}</p></div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => runMutation.mutate(selected.id)} disabled={runMutation.isPending}><Play className="h-4 w-4" />Run now</Button>
                <Button size="sm" variant="outline" onClick={() => setEnabledMutation.mutate({ id: selected.id, enabled: !selected.enabled })} disabled={setEnabledMutation.isPending}>{selected.enabled ? 'Disable' : 'Enable'}</Button>
                <Button size="sm" variant="outline" onClick={openEdit}>Edit</Button>
                {selected.trigger.type === 'webhook' && <Button size="sm" variant="outline" onClick={() => rotateWebhookMutation.mutate(selected.id)} disabled={rotateWebhookMutation.isPending}><RefreshCw className="h-4 w-4" />Rotate webhook secret</Button>}
                <Button size="icon-sm" variant="ghost" aria-label="Delete automation" onClick={() => { if (window.confirm(`Delete “${selected.name}”?`)) deleteMutation.mutate(selected.id) }} disabled={deleteMutation.isPending}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
            <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
              <div className="rounded-lg border p-4">
                <h3 className="font-medium">Workflow</h3>
                <dl className="mt-3 space-y-3 text-sm">
                  <InfoRow label="Trigger" value={triggerLabel(selected.trigger)} />
                  <InfoRow label="Agent" value={agentName(agentsQuery.data, selected.agentId)} />
                  <InfoRow label="Prompt" value={selected.promptTemplate} multiline />
                  <InfoRow label="Actions" value={selected.actions.length ? selected.actions.map((action) => action.type).join(', ') : 'Store output'} />
                </dl>
              </div>
              <div className="rounded-lg border">
                <div className="flex items-center justify-between border-b px-4 py-3"><div><h3 className="font-medium">Execution history</h3><p className="text-xs text-muted-foreground">Runs reference the canonical Subpolar run.</p></div><Activity className="h-4 w-4 text-muted-foreground" /></div>
                {executionsQuery.isLoading ? <div className="p-4 text-sm text-muted-foreground">Loading history…</div> : null}
                {executionsQuery.isError ? <div className="p-4 text-sm text-destructive">{errorText(executionsQuery.error)}</div> : null}
                {!executionsQuery.isLoading && executionsQuery.data?.length === 0 ? <div className="p-4 text-sm text-muted-foreground">No executions yet.</div> : null}
                <div className="divide-y">
                  {executionsQuery.data?.map((execution) => <ExecutionRow key={execution.id} execution={execution} />)}
                </div>
              </div>
            </div>
          </> : <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground"><Bot className="h-8 w-8" /><p>Select an automation or create one.</p></div>}
        </section>
      </main>

      <AutomationEditor
        key={editing?.id ?? 'new'}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        agents={agentsQuery.data ?? []}
        busy={createMutation.isPending || updateMutation.isPending}
        onSave={(input) => editing ? updateMutation.mutate({ id: editing.id, input }) : createMutation.mutate(input)}
      />
      <WebhookSecretDialog credential={webhookCredential} onClose={() => setWebhookCredential(null)} />
    </div>
  )
}

function agentName(agents: Array<{ id: string; name: string }> | undefined, agentId: string): string {
  return agents?.find((agent) => agent.id === agentId)?.name ?? agentId
}

function InfoRow({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`mt-1 break-words ${multiline ? 'whitespace-pre-wrap' : ''}`}>{value}</dd></div>
}

function ExecutionRow({ execution }: { execution: AutomationExecution }) {
  const date = execution.startedAt ?? execution.createdAt
  const outputText = typeof execution.output === 'string'
    ? execution.output
    : execution.output && typeof execution.output === 'object' && 'text' in execution.output && typeof execution.output.text === 'string'
      ? execution.output.text
      : null
  const error = typeof execution.error === 'string' ? execution.error : execution.error?.message
  return <div className="px-4 py-3">
    <div className="flex items-center justify-between gap-3"><div className="text-sm">{new Date(date).toLocaleString()}</div><span className={`text-xs font-medium ${statusTone(execution.status)}`}>{execution.status.replaceAll('_', ' ')}</span></div>
    {execution.canonicalRunId && <div className="mt-1 break-all font-mono text-xs text-muted-foreground">Run {execution.canonicalRunId}</div>}
    {execution.canonicalSessionId && <Link className="mt-1 inline-block text-xs text-primary underline" to={`/projects/${execution.projectId ?? 0}/sessions/${encodeURIComponent(execution.canonicalSessionId)}`}>Open canonical run</Link>}
    {outputText && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{outputText}</p>}
    {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    {execution.actions?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{execution.actions.map((action) => <span key={action.id} className={`rounded bg-muted px-2 py-1 text-xs ${statusTone(action.status)}`}>{action.type}: {action.status}</span>)}</div> : null}
  </div>
}

function AutomationEditor({
  open,
  onOpenChange,
  editing,
  agents,
  busy,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: AutomationDefinition | null
  agents: Array<{ id: string; name: string }>
  busy: boolean
  onSave: (input: CreateAutomationInput) => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [agentId, setAgentId] = useState(editing?.agentId ?? '')
  const [promptTemplate, setPromptTemplate] = useState(editing?.promptTemplate ?? '')
  const [triggerType, setTriggerType] = useState<TriggerType>(editing?.trigger.type ?? 'manual')
  const [cron, setCron] = useState(editing?.trigger.type === 'schedule' ? editing.trigger.cron : '0 8 * * *')
  const [timezone, setTimezone] = useState(editing?.trigger.type === 'schedule' ? editing.trigger.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [eventType, setEventType] = useState(editing?.trigger.type === 'event' ? editing.trigger.eventType : 'run.completed')
  const [actions, setActions] = useState<AutomationAction[]>(editing?.actions ?? [])
  const [actionType, setActionType] = useState<ActionType>('store')
  const [actionId, setActionId] = useState('')
  const [actionBody, setActionBody] = useState('')

  const trigger = useMemo<AutomationTrigger>(() => {
    if (triggerType === 'schedule') return { type: 'schedule', cron, timezone }
    // The application owns this credential and replaces this placeholder when saving.
    if (triggerType === 'webhook') return { type: 'webhook', credentialRef: 'managed-webhook' }
    if (triggerType === 'event') return { type: 'event', eventType }
    return { type: 'manual' }
  }, [triggerType, cron, timezone, eventType])

  const addAction = () => {
    const id = actionId.trim() || `${actionType}-${crypto.randomUUID().slice(0, 8)}`
    let action: AutomationAction
    if (actionType === 'notification') action = { id, type: 'notification', titleTemplate: 'Automation result', bodyTemplate: '{{ output.text }}' }
    else if (actionType === 'webhook') action = { id, type: 'webhook', url: actionBody.trim(), bodyTemplate: '{{ output.text }}' }
    else if (actionType === 'tool') action = { id, type: 'tool', toolId: actionBody.trim(), inputTemplate: '{{ output.text }}' }
    else action = { id, type: 'store' }
    setActions((current) => [...current, action])
    setActionId('')
    setActionBody('')
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!agentId) { showToast.error('Choose an agent for this automation'); return }
    if ((trigger.type === 'schedule' && !cron.trim()) || (trigger.type === 'event' && !eventType.trim())) { showToast.error('Complete the trigger configuration'); return }
    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      enabled: editing?.enabled ?? true,
      agentId,
      promptTemplate,
      trigger,
      actions,
      ...(editing?.projectId ? { projectId: editing.projectId } : {}),
      ...(editing?.executionConfig ? { executionConfig: editing.executionConfig } : {}),
    })
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
      <DialogHeader><DialogTitle>{editing ? 'Edit automation' : 'Create automation'}</DialogTitle><DialogDescription>Configure a trigger and the existing Subpolar agent that processes it.</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} /></Field>
          <Field label="Agent"><Select value={agentId} onValueChange={setAgentId}><SelectTrigger><SelectValue placeholder="Select an agent" /></SelectTrigger><SelectContent>{agents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}</SelectContent></Select></Field>
        </div>
        <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} /></Field>
        <Field label="Agent prompt template"><Textarea value={promptTemplate} onChange={(event) => setPromptTemplate(event.target.value)} required rows={4} placeholder="Summarize this event: {{ trigger.payload }}" /></Field>
        <div className="space-y-3 rounded-lg border p-3">
          <Field label="Trigger"><Select value={triggerType} onValueChange={(value) => setTriggerType(value as TriggerType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="manual">Manual</SelectItem><SelectItem value="schedule">Schedule</SelectItem><SelectItem value="webhook">Webhook</SelectItem><SelectItem value="event">Internal event</SelectItem></SelectContent></Select></Field>
          {triggerType === 'schedule' && <div className="grid gap-3 sm:grid-cols-2"><Field label="Five-field cron"><Input value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 8 * * *" /></Field><Field label="Timezone"><Input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Europe/Berlin" /></Field></div>}
          {triggerType === 'webhook' && <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">Subpolar will create a private webhook URL and secret when you save this automation. The secret is shown once so you can copy it.</p>}
          {triggerType === 'event' && <Field label="Event type"><Input value={eventType} onChange={(event) => setEventType(event.target.value)} placeholder="run.completed" /></Field>}
        </div>
        <div className="space-y-3 rounded-lg border p-3">
          <div><h3 className="text-sm font-medium">Output actions</h3><p className="text-xs text-muted-foreground">Actions run after the selected agent finishes. Store output is available by default.</p></div>
          <div className="flex flex-wrap gap-2">{actions.map((action) => <span key={action.id} className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs">{action.type}{action.type === 'webhook' ? ` · ${action.url}` : action.type === 'tool' ? ` · ${action.toolId}` : ''}<button type="button" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${action.id}`} onClick={() => setActions((current) => current.filter((item) => item.id !== action.id))}>×</button></span>)}</div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Select value={actionType} onValueChange={(value) => setActionType(value as ActionType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="store">Store result</SelectItem><SelectItem value="notification">Notification</SelectItem><SelectItem value="webhook">Webhook POST</SelectItem><SelectItem value="tool">Subpolar tool</SelectItem></SelectContent></Select>
            <Input value={actionBody} onChange={(event) => setActionBody(event.target.value)} placeholder={actionType === 'webhook' ? 'https://example.com/hook' : actionType === 'tool' ? 'tool-id' : 'Optional action id'} />
            <Button type="button" variant="outline" onClick={addAction} disabled={(actionType === 'webhook' || actionType === 'tool') && !actionBody.trim()}><Plus className="h-4 w-4" />Add</Button>
          </div>
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !agents.length}><Save className="h-4 w-4" />{busy ? 'Saving…' : 'Save automation'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>
}

function WebhookSecretDialog({ credential, onClose }: { credential: ManagedWebhookCredential | null; onClose: () => void }) {
  const endpoint = credential ? new URL(credential.url, window.location.origin).toString() : ''
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast.success(`${label} copied`)
    } catch {
      showToast.error(`Could not copy ${label.toLowerCase()}`)
    }
  }

  return <Dialog open={Boolean(credential)} onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Webhook secret generated</DialogTitle>
        <DialogDescription>Copy the endpoint and secret now. The secret is shown only once; rotating it will invalidate the previous secret.</DialogDescription>
      </DialogHeader>
      {credential && <div className="space-y-4">
        <div className="space-y-1.5"><Label>Webhook endpoint</Label><div className="flex gap-2"><Input readOnly value={endpoint} /><Button type="button" variant="outline" size="icon" aria-label="Copy webhook endpoint" onClick={() => void copy(endpoint, 'Webhook endpoint')}><Copy className="h-4 w-4" /></Button></div></div>
        <div className="space-y-1.5"><Label>One-time secret</Label><div className="flex gap-2"><Input readOnly type="text" value={credential.secret} autoComplete="off" /><Button type="button" variant="outline" size="icon" aria-label="Copy webhook secret" onClick={() => void copy(credential.secret, 'Webhook secret')}><Copy className="h-4 w-4" /></Button></div></div>
        <p className="text-xs text-muted-foreground">Store this secret in your webhook sender. Subpolar will not show it again.</p>
      </div>}
      <DialogFooter><Button type="button" onClick={onClose}>Done</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
