import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Play, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { settingsApi, type AgentDebugTool } from '@/api/settings'

type JsonSchemaProperty = {
  type?: string
  title?: string
  description?: string
  enum?: unknown[]
  default?: unknown
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value)
}

export function DebugToolsDialog({
  open,
  onOpenChange,
  sessionID,
  agentName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionID: string
  agentName: string
}) {
  const [tools, setTools] = useState<AgentDebugTool[]>([])
  const [loadingTools, setLoadingTools] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [selectedTool, setSelectedTool] = useState<AgentDebugTool>()
  const [values, setValues] = useState<Record<string, string>>({})
  const [rawInput, setRawInput] = useState('{}')
  const [inputError, setInputError] = useState<string>()
  const [result, setResult] = useState<unknown>()
  const [calling, setCalling] = useState(false)

  useEffect(() => {
    if (!open) return
    let current = true
    setLoadingTools(true)
    setLoadError(undefined)
    setSelectedTool(undefined)
    setResult(undefined)
    void settingsApi.listAgentDebugTools(agentName, sessionID)
      .then(({ tools: available }) => { if (current) setTools(available) })
      .catch((error: unknown) => { if (current) setLoadError(error instanceof Error ? error.message : 'Unable to load tools') })
      .finally(() => { if (current) setLoadingTools(false) })
    return () => { current = false }
  }, [agentName, open, sessionID])

  const schema = selectedTool?.inputSchema ?? {}
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, JsonSchemaProperty>
    : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []
  const hasProperties = Object.keys(properties).length > 0

  const beginTool = (tool: AgentDebugTool) => {
    setSelectedTool(tool)
    setResult(undefined)
    setInputError(undefined)
    const toolSchema = tool.inputSchema
    const toolProperties = toolSchema.properties && typeof toolSchema.properties === 'object'
      ? toolSchema.properties as Record<string, JsonSchemaProperty>
      : {}
    setValues(Object.fromEntries(Object.entries(toolProperties).map(([name, property]) => [name, displayValue(property.default)])))
    setRawInput('{}')
  }

  const buildInput = (): Record<string, unknown> => {
    if (!selectedTool) return {}
    if (Object.keys(properties).length === 0) {
      const parsed: unknown = JSON.parse(rawInput || '{}')
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Input must be a JSON object')
      return parsed as Record<string, unknown>
    }

    const input: Record<string, unknown> = {}
    for (const [name, property] of Object.entries(properties)) {
      const value = values[name] ?? ''
      if (!value && required.includes(name)) throw new Error(`${property.title || name} is required`)
      if (!value) continue
      if (property.enum) {
        const option = property.enum.find((item) => displayValue(item) === value)
        if (option === undefined) throw new Error(`Choose a valid value for ${property.title || name}`)
        input[name] = option
      } else if (property.type === 'boolean') {
        input[name] = value === 'true'
      } else if (property.type === 'number' || property.type === 'integer') {
        const number = Number(value)
        if (!Number.isFinite(number)) throw new Error(`${property.title || name} must be a number`)
        input[name] = number
      } else if (property.type === 'array' || property.type === 'object') {
        input[name] = JSON.parse(value)
      } else {
        input[name] = value
      }
    }
    return input
  }

  const handleExecute = async () => {
    if (!selectedTool) return
    setInputError(undefined)
    setResult(undefined)
    let input: Record<string, unknown>
    try {
      input = buildInput()
    } catch (error) {
      setInputError(error instanceof Error ? error.message : 'Invalid tool parameters')
      return
    }
    setCalling(true)
    try {
      setResult(await settingsApi.callAgentDebugTool({ toolId: selectedTool.id, sessionId: sessionID, agentName, input }))
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : 'Tool execution failed' })
    } finally {
      setCalling(false)
    }
  }

  const sortedTools = useMemo(() => [...tools].sort((left, right) => left.id.localeCompare(right.id)), [tools])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2"><Wrench className="h-4 w-4" /> Debug agent tools</DialogTitle>
          <DialogDescription>Available tools for {agentName}. Calls use this session’s permissions and approval rules.</DialogDescription>
        </DialogHeader>

        {!selectedTool ? (
          <div className="min-h-0 overflow-y-auto p-4">
            {loadingTools && <p className="py-8 text-center text-sm text-muted-foreground">Loading tools…</p>}
            {loadError && <p role="alert" className="py-4 text-sm text-destructive">{loadError}</p>}
            {!loadingTools && !loadError && sortedTools.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No tools available to this agent.</p>}
            <div className="space-y-2">
              {sortedTools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => beginTool(tool)}
                  className="w-full rounded-lg border border-border bg-background p-3 text-left transition-colors hover:bg-accent/50"
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="font-mono text-sm font-medium">{tool.id}</span>
                    {tool.requiresApproval && <span className="text-xs text-amber-600 dark:text-amber-400">Approval may be required</span>}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">{tool.description}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="min-h-0 overflow-y-auto p-5">
            <Button type="button" variant="ghost" size="sm" className="mb-3 -ml-2" onClick={() => { setSelectedTool(undefined); setResult(undefined) }}>
              <ArrowLeft className="mr-1 h-4 w-4" /> All tools
            </Button>
            <h3 className="font-mono text-sm font-semibold">{selectedTool.id}</h3>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">{selectedTool.description}</p>
            {selectedTool.requiresApproval && (
              <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                This tool may request approval in the session before it runs.
              </div>
            )}
            {hasProperties ? (
              <div className="space-y-4">
                {Object.entries(properties).map(([name, property]) => (
                  <label key={name} className="block space-y-1.5">
                    <span className="text-sm font-medium">{property.title || name}{required.includes(name) && <span className="text-destructive"> *</span>}</span>
                    {property.description && <span className="block text-xs text-muted-foreground">{property.description}</span>}
                    {property.enum ? (
                      <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={values[name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}>
                        <option value="">Select…</option>
                        {property.enum.map((option) => <option key={displayValue(option)} value={displayValue(option)}>{displayValue(option)}</option>)}
                      </select>
                    ) : property.type === 'boolean' ? (
                      <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={values[name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}>
                        <option value="">Select…</option><option value="true">true</option><option value="false">false</option>
                      </select>
                    ) : property.type === 'object' || property.type === 'array' ? (
                      <Textarea className="font-mono" value={values[name] ?? ''} placeholder={property.type === 'array' ? '[]' : '{}'} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} />
                    ) : (
                      <Input type={property.type === 'number' || property.type === 'integer' ? 'number' : 'text'} value={values[name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} />
                    )}
                  </label>
                ))}
              </div>
            ) : (
              <label className="block space-y-2 text-sm font-medium">
                Parameters (JSON)
                <Textarea className="min-h-32 font-mono" value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} />
              </label>
            )}
            {inputError && <p role="alert" className="mt-3 text-sm text-destructive">{inputError}</p>}
            <div className="mt-5 flex justify-end">
              <Button type="button" onClick={() => void handleExecute()} disabled={calling}>
                <Play className="mr-2 h-4 w-4" />{calling ? 'Running…' : 'Run tool'}
              </Button>
            </div>
            {result !== undefined && (
              <div className="mt-5 rounded-lg border border-border bg-muted/40 p-3">
                {typeof result === 'object' && result !== null && 'status' in result && result.status === 'approval_required' && (
                  <p className="mb-2 text-sm font-medium text-amber-700 dark:text-amber-300">Approval requested. Respond to the approval in this session.</p>
                )}
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(result, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
