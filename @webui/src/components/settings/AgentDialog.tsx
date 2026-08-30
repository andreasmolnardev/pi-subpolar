import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { settingsApi, type AgentToolPolicy, type SubpolarTool } from '@/api/settings'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Trash2 } from 'lucide-react'
import type { AgentSkillAccess, SkillDiscoveryMode, SkillFileInfo } from '@subpolar/shared'
import { buildAgentPromptPreview } from '@/lib/agentPromptPreview'

const toolAccessSchema = z.object({
  type: z.enum(['builtin', 'cli', 'subpolar']),
  id: z.string().min(1),
  permission: z.enum(['allow', 'ask', 'deny']),
  command: z.string().optional(),
})

const agentSkillAccessSchema = z.object({
  id: z.string().min(1),
  discovery: z.enum(['full', 'description', 'name', 'search']),
  source: z.enum(['manual', 'tool-default', 'project-auto']).optional(),
})

const agentFormSchema = z.object({
  name: z.string().min(1, 'Agent name is required').regex(/^[a-z0-9-]+$/, 'Must be lowercase letters, numbers, and hyphens only'),
  description: z.string().optional(),
  prompt: z.string().min(1, 'Prompt is required'),
  systemPrompt: z.string(),
  disable: z.boolean(),
  icon: z.string().optional(),
  skills: z.array(z.string()).optional(),
  skillAccess: z.array(agentSkillAccessSchema).optional(),
  allowedCommands: z.array(z.string()).optional(),
  toolAccess: z.array(toolAccessSchema).optional(),
})

type AgentFormValues = z.infer<typeof agentFormSchema>
type ToolAccess = z.infer<typeof toolAccessSchema>

interface Agent {
  id?: string
  prompt?: string
  systemPrompt?: string
  description?: string
  mode?: 'subagent' | 'primary' | 'all'
  temperature?: number
  topP?: number
  top_p?: number
  model?: string
  tools?: Record<string, boolean>
  permission?: {
    edit?: 'ask' | 'allow' | 'deny'
    bash?: 'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>
    webfetch?: 'ask' | 'allow' | 'deny'
  }
  icon?: string
  skills?: string[]
  skillAccess?: AgentSkillAccess[]
  allowedCommands?: string[]
  toolAccess?: Array<z.infer<typeof toolAccessSchema> | { type: 'skill'; id: string; permission: 'allow' | 'ask' | 'deny'; command?: string }>
  disable?: boolean
  [key: string]: unknown
}

const BUILTIN_TOOL_LABELS: Record<string, string> = {
  edit: 'Edit Files',
  webfetch: 'Web Fetch',
  'other-bash': 'Other Bash Commands',
}

const CLI_TOOL_SELECTION = 'other:cli'

const EMPTY_TOOL_ACCESS: ToolAccess[] = []
const EMPTY_SKILL_ACCESS: AgentSkillAccess[] = []

function generatedToolSkillName(toolId: string): string {
  return `tool-${toolId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

function generatedToolSkill(tool: SubpolarTool): SkillFileInfo {
  return {
    name: generatedToolSkillName(tool.tool_id),
    description: `Auto-generated skill for ${tool.tool_id}: ${tool.description}`,
    body: '',
    inputSchema: tool.input_schema,
    scope: 'global',
    location: `subpolar-tool://${tool.tool_id}`,
    source: 'auto',
  }
}

function permissionFrom(value: unknown, fallback: 'allow' | 'ask' | 'deny' = 'deny'): 'allow' | 'ask' | 'deny' {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : fallback
}

function policyPermission(effect: AgentToolPolicy['effect']): 'allow' | 'ask' | 'deny' {
  if (effect === 'approval') return 'ask'
  return effect
}

function buildToolAccess(agent?: Agent, policies: AgentToolPolicy[] = []): ToolAccess[] {
  const configured = agent?.toolAccess?.length ? agent.toolAccess.filter(tool => tool.type !== 'subpolar' && tool.type !== 'skill') as ToolAccess[] : undefined
  const bashPermission = agent?.permission?.bash
  const piBashPolicy = policies.find(policy => policy.tool_id === 'pi.bash')
  const fallback = [
    { type: 'builtin' as const, id: 'edit', permission: permissionFrom(agent?.permission?.edit, 'allow') },
    { type: 'builtin' as const, id: 'webfetch', permission: permissionFrom(agent?.permission?.webfetch, 'allow') },
    { type: 'builtin' as const, id: 'other-bash', permission: piBashPolicy ? policyPermission(piBashPolicy.effect) : typeof bashPermission === 'string' ? permissionFrom(bashPermission, 'ask') : 'deny' },
    ...(agent?.allowedCommands || []).map((command): ToolAccess => ({ type: 'cli', id: command, command, permission: 'allow' })),
  ]
  const base = configured ?? fallback
  const subpolar = policies.filter(policy => !policy.tool_id.startsWith('pi.')).map((policy): ToolAccess => ({
    type: 'subpolar',
    id: policy.tool_id,
    permission: policyPermission(policy.effect),
  }))
  return [
    ...base,
    ...subpolar,
  ]
}

function buildSkillAccess(agent?: Agent): AgentSkillAccess[] {
  if (agent?.skillAccess?.length) return agent.skillAccess
  return (agent?.skills ?? []).map(id => ({ id, discovery: 'description', source: 'manual' as const }))
}

interface AgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string, agent: Agent) => void | Promise<void>
  editingAgent?: { name: string; agent: Agent } | null
  availableSkills?: SkillFileInfo[]
}

export function AgentDialog({ open, onOpenChange, onSubmit, editingAgent, availableSkills = [] }: AgentDialogProps) {
  const [selectedToolIndex, setSelectedToolIndex] = useState(0)
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0)

  const { data: subpolarToolsResponse } = useQuery({
    queryKey: ['subpolar-tools'],
    queryFn: () => settingsApi.listSubpolarTools(),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  })

  const { data: policyResponse } = useQuery({
    queryKey: ['agent-tool-policies', editingAgent?.agent.id ?? editingAgent?.name],
    queryFn: () => settingsApi.listAgentToolPolicies(editingAgent!.agent.id ?? editingAgent!.name),
    enabled: open && !!editingAgent?.name,
  })

  const subpolarTools = useMemo(() => subpolarToolsResponse?.tools ?? [], [subpolarToolsResponse?.tools])
  const mcpTools = useMemo(() => subpolarTools.filter(tool => tool.adapter === 'mcp' || tool.namespace === 'mcp'), [subpolarTools])
  const openApiTools = useMemo(() => subpolarTools.filter(tool => tool.adapter === 'openapi' || tool.namespace === 'openapi'), [subpolarTools])
  const nativeSubpolarTools = useMemo(() => subpolarTools.filter(tool => tool.adapter !== 'mcp' && tool.namespace !== 'mcp' && tool.adapter !== 'openapi' && tool.namespace !== 'openapi'), [subpolarTools])
  const policies = useMemo(() => policyResponse?.policies ?? [], [policyResponse?.policies])
  const availableSkillNames = useMemo(() => availableSkills.map(skill => skill.name), [availableSkills])
  const generatedToolSkills = useMemo(() => subpolarTools.map(generatedToolSkill), [subpolarTools])
  const promptSkills = useMemo(() => {
    const skillsByName = new Map(availableSkills.map(skill => [skill.name, skill]))
    for (const skill of generatedToolSkills) skillsByName.set(skill.name, skill)
    return [...skillsByName.values()]
  }, [availableSkills, generatedToolSkills])

  const getDefaultValues = useCallback((agent?: { name: string; agent: Agent } | null): AgentFormValues => {
    return {
      name: agent?.name || '',
      description: agent?.agent.description || '',
      prompt: agent?.agent.prompt || '',
      systemPrompt: agent?.agent.systemPrompt || '',
      disable: agent?.agent.disable ?? false,
      icon: agent?.agent.icon || '',
      skills: agent?.agent.skills || [],
      skillAccess: buildSkillAccess(agent?.agent),
      allowedCommands: agent?.agent.allowedCommands || [],
      toolAccess: buildToolAccess(agent?.agent, policies),
    }
  }, [policies])

  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    mode: 'onChange',
    defaultValues: getDefaultValues(editingAgent)
  })

  useEffect(() => {
    if (open) {
      form.reset(getDefaultValues(editingAgent))
      setSelectedToolIndex(0)
      setSelectedSkillIndex(0)
    }
  }, [open, editingAgent, form, getDefaultValues])

  const toolAccess = form.watch('toolAccess') ?? EMPTY_TOOL_ACCESS
  const skillAccess = form.watch('skillAccess') ?? EMPTY_SKILL_ACCESS
  const promptValue = form.watch('prompt')
  const systemPromptValue = form.watch('systemPrompt')
  const selectedTool = toolAccess[selectedToolIndex]
  const selectedSkill = skillAccess[selectedSkillIndex]
  const promptPreview = useMemo(() => buildAgentPromptPreview({ prompt: promptValue, skillAccess, skills: promptSkills }), [promptValue, skillAccess, promptSkills])

  const addToolAccess = () => {
    const defaultTool = subpolarTools[0]?.tool_id ?? 'calendar.get'
    const next = [...toolAccess, { type: 'subpolar' as const, id: defaultTool, permission: 'allow' as const }]
    form.setValue('toolAccess', next, { shouldDirty: true, shouldValidate: true })
    setSelectedToolIndex(next.length - 1)
  }

  const removeToolAccess = (index: number) => {
    const next = toolAccess.filter((_, itemIndex) => itemIndex !== index)
    form.setValue('toolAccess', next, { shouldDirty: true, shouldValidate: true })
    setSelectedToolIndex(Math.max(0, Math.min(index, next.length - 1)))
  }

  const updateSelectedTool = (patch: Partial<ToolAccess>) => {
    const next = toolAccess.map((tool, index) => index === selectedToolIndex ? { ...tool, ...patch } : tool)
    form.setValue('toolAccess', next, { shouldDirty: true, shouldValidate: true })
  }

  const selectTool = (value: string) => {
    if (value === CLI_TOOL_SELECTION) {
      updateSelectedTool({ type: 'cli', id: selectedTool?.command ?? '', command: selectedTool?.command ?? '' })
      return
    }

    const [type, ...idParts] = value.split(':')
    updateSelectedTool({
      type: type as 'builtin' | 'subpolar',
      id: idParts.join(':'),
      command: undefined,
    })
  }

  const addSkillAccess = (source: AgentSkillAccess['source'] = 'manual') => {
    const id = availableSkillNames.find(name => !skillAccess.some(skill => skill.id === name)) ?? 'research'
    const next = [...skillAccess, { id, discovery: 'description' as const, source }]
    form.setValue('skillAccess', next, { shouldDirty: true, shouldValidate: true })
    setSelectedSkillIndex(next.length - 1)
  }

  const removeSkillAccess = (index: number) => {
    const next = skillAccess.filter((_, itemIndex) => itemIndex !== index)
    form.setValue('skillAccess', next, { shouldDirty: true, shouldValidate: true })
    setSelectedSkillIndex(Math.max(0, Math.min(index, next.length - 1)))
  }

  const updateSelectedSkill = (patch: Partial<AgentSkillAccess>) => {
    const next = skillAccess.map((skill, index) => index === selectedSkillIndex ? { ...skill, ...patch } : skill)
    form.setValue('skillAccess', next, { shouldDirty: true, shouldValidate: true })
  }

  useEffect(() => {
    const webfetch = toolAccess.find(tool => tool.type === 'builtin' && tool.id === 'webfetch')
    const hasResearch = skillAccess.some(skill => skill.id === 'research')
    const hasResearchSkill = availableSkillNames.includes('research')
    if (webfetch && webfetch.permission !== 'deny' && hasResearchSkill && !hasResearch) {
      form.setValue('skillAccess', [...skillAccess, { id: 'research', discovery: 'description', source: 'tool-default' }], { shouldDirty: true, shouldValidate: true })
    }
  }, [availableSkillNames, form, skillAccess, toolAccess])

  useEffect(() => {
    const selectedToolSkillIds = new Set(toolAccess
      .filter(tool => tool.type === 'subpolar' && tool.permission !== 'deny')
      .map(tool => generatedToolSkillName(tool.id)))
    const retainedSkills = skillAccess.filter(skill => skill.source !== 'tool-default' || !skill.id.startsWith('tool-') || selectedToolSkillIds.has(skill.id))
    const existingSkillIds = new Set(retainedSkills.map(skill => skill.id))
    const addedSkills = [...selectedToolSkillIds]
      .filter(id => !existingSkillIds.has(id))
      .map(id => ({ id, discovery: 'name' as const, source: 'tool-default' as const }))
    const next = [...retainedSkills, ...addedSkills]
    if (next.length !== skillAccess.length || next.some((skill, index) => skill.id !== skillAccess[index]?.id || skill.discovery !== skillAccess[index]?.discovery || skill.source !== skillAccess[index]?.source)) {
      form.setValue('skillAccess', next, { shouldDirty: true, shouldValidate: true })
    }
  }, [form, skillAccess, toolAccess])

  const handleSubmit = async (values: AgentFormValues) => {
    const selectedGeneratedToolIds = new Set((values.skillAccess ?? []).flatMap((skill) => {
      const tool = subpolarTools.find((item) => generatedToolSkillName(item.tool_id) === skill.id)
      return tool ? [tool.tool_id] : []
    }))
    const configuredToolIds = new Set((values.toolAccess ?? [])
      .filter((tool) => tool.type === 'subpolar')
      .map((tool) => tool.id))
    const effectiveToolAccess = [
      ...(values.toolAccess ?? []).map((tool) =>
        tool.type === 'subpolar' && selectedGeneratedToolIds.has(tool.id)
          ? { ...tool, permission: 'allow' as const }
          : tool,
      ),
      ...[...selectedGeneratedToolIds]
        .filter((toolId) => !configuredToolIds.has(toolId))
        .map((toolId) => ({ type: 'subpolar' as const, id: toolId, permission: 'allow' as const })),
    ]
    const agent: Agent = {
      prompt: values.prompt,
      systemPrompt: values.systemPrompt.trim() || promptPreview,
      description: values.description || undefined,
      disable: values.disable,
      tools: {},
      permission: {}
    }

    if (editingAgent?.agent.mode) {
      agent.mode = editingAgent.agent.mode
    }

    if (editingAgent?.agent.temperature !== undefined) {
      agent.temperature = editingAgent.agent.temperature
    }

    if (editingAgent?.agent.topP !== undefined) {
      agent.topP = editingAgent.agent.topP
    } else if (editingAgent?.agent.top_p !== undefined) {
      agent.top_p = editingAgent.agent.top_p
    }

    if (values.icon) {
      agent.icon = values.icon
    }

    if (values.skills && values.skills.length > 0) {
      agent.skills = values.skills
    }

    if (values.skillAccess && values.skillAccess.length > 0) {
      agent.skillAccess = values.skillAccess
      agent.skills = Array.from(new Set(values.skillAccess.map(skill => skill.id)))
    }

    if (values.allowedCommands && values.allowedCommands.length > 0) {
      agent.allowedCommands = values.allowedCommands
    }

    if (effectiveToolAccess.length > 0) {
      agent.toolAccess = effectiveToolAccess
      const builtinTools = Object.fromEntries(effectiveToolAccess.filter(tool => tool.type === 'builtin').map(tool => [tool.id, tool]))
      const editPermission = builtinTools.edit?.permission || 'deny'
      const webfetchPermission = builtinTools.webfetch?.permission || 'deny'
      const otherBashPermission = builtinTools['other-bash']?.permission || 'deny'
      agent.tools = {
        edit: editPermission !== 'deny',
        bash: otherBashPermission !== 'deny' || effectiveToolAccess.some(tool => tool.type === 'cli'),
        webfetch: webfetchPermission !== 'deny',
      }
      agent.permission = {
        edit: editPermission,
        webfetch: webfetchPermission,
        bash: otherBashPermission,
      }
      agent.allowedCommands = Array.from(new Set(effectiveToolAccess.filter(tool => tool.type === 'cli').map(tool => tool.command || tool.id)))
      const cliTools = effectiveToolAccess.filter(tool => tool.type === 'cli')
      if (cliTools.length > 0 || otherBashPermission !== 'deny') {
        agent.permission = {
          ...agent.permission,
          bash: Object.fromEntries([
            ...cliTools.map(tool => [`${tool.command || tool.id} *`, tool.permission]),
            ['*', otherBashPermission],
          ]),
        }
      }
    }

    await onSubmit(values.name, agent)
    form.reset()
    onOpenChange(false)
  }

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      form.reset()
    }
    onOpenChange(isOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent mobileFullscreen className="xl:max-w-6xl sm:max-h-[85vh] gap-0 flex flex-col p-0 md:p-6">
        <DialogHeader className="p-4 sm:p-6 border-b flex flex-row items-center justify-between space-y-0">
          <DialogTitle>{editingAgent ? 'Edit Agent' : 'Create Agent'}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-2 sm:p-4">
          <Form {...form}>
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-4">
              <div className="grid grid-cols-[minmax(3.25rem,auto)_1fr] gap-3 items-start">
                <FormField
                  control={form.control}
                  name="icon"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Icon</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="🤖"
                          maxLength={4}
                          className="w-14 min-w-14 text-center text-lg px-2"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Agent Name</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="my-agent"
                          disabled={!!editingAgent}
                          className={editingAgent ? 'bg-muted' : ''}
                        />
                      </FormControl>
                      <FormDescription>
                        Use lowercase letters, numbers, and hyphens only
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="Brief description of what the agent does"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="prompt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Prompt</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="The system prompt that defines the agent's behavior and role"
                        rows={6}
                        className="font-mono md:text-sm"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="systemPrompt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>System Prompt</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder={promptPreview}
                        rows={10}
                        className="font-mono md:text-sm"
                      />
                    </FormControl>
                    <FormDescription>Generated from the agent configuration when left blank. Edit it to override the generated prompt.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              </div>

              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">Tool Permissions</div>
                    <p className="text-xs text-muted-foreground">Configure direct CLI utilities and Subpolar backend-routed tool calls.</p>
                  </div>
                </div>
                <div className="min-w-0 flex gap-2 overflow-x-auto pb-1">
                  {toolAccess.map((tool, index) => (
                    <button
                      key={`${tool.type}-${tool.id}-${index}`}
                      type="button"
                      onClick={() => setSelectedToolIndex(index)}
                      className={`min-w-36 shrink-0 rounded-md border p-3 text-left text-sm transition-colors ${selectedToolIndex === index ? 'border-primary bg-primary/10' : 'bg-card hover:bg-muted'}`}
                    >
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">{tool.type}</div>
                      <div className="truncate font-medium">{tool.id}</div>
                      <div className="text-xs text-muted-foreground">{tool.permission}</div>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={addToolAccess}
                    className="min-w-24 shrink-0 rounded-md border border-dashed p-3 text-sm text-muted-foreground hover:bg-muted flex items-center justify-center"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>

                {selectedTool ? (
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Tool</label>
                      <Select value={selectedTool.type === 'cli' ? CLI_TOOL_SELECTION : `${selectedTool.type}:${selectedTool.id}`} onValueChange={selectTool}>
                        <SelectTrigger><SelectValue placeholder="Select a tool" /></SelectTrigger>
                        <SelectContent className="max-h-80 overflow-y-auto">
                          <SelectGroup>
                            <SelectLabel>Built-in tools</SelectLabel>
                            {Object.entries(BUILTIN_TOOL_LABELS).map(([id, label]) => <SelectItem key={id} value={`builtin:${id}`}>{label}</SelectItem>)}
                          </SelectGroup>
                          {nativeSubpolarTools.length > 0 && (
                            <SelectGroup>
                              <SelectLabel>Subpolar tools</SelectLabel>
                              {nativeSubpolarTools.map((tool: SubpolarTool) => <SelectItem key={tool.tool_id} value={`subpolar:${tool.tool_id}`}>{tool.tool_id}</SelectItem>)}
                            </SelectGroup>
                          )}
                          {mcpTools.length > 0 && (
                            <SelectGroup>
                              <SelectLabel>MCP server tools</SelectLabel>
                              {mcpTools.map((tool: SubpolarTool) => {
                                const serverName = typeof tool.metadata?.serverName === 'string' ? tool.metadata.serverName : 'Configured MCP server'
                                return <SelectItem key={tool.tool_id} value={`subpolar:${tool.tool_id}`}>{serverName} · {tool.tool_id}</SelectItem>
                              })}
                            </SelectGroup>
                          )}
                          {openApiTools.length > 0 && (
                            <SelectGroup>
                              <SelectLabel>OpenAPI provider tools</SelectLabel>
                              {openApiTools.map((tool: SubpolarTool) => <SelectItem key={tool.tool_id} value={`subpolar:${tool.tool_id}`}>{typeof tool.metadata?.providerName === 'string' ? tool.metadata.providerName : 'OpenAPI'} · {tool.tool_id}</SelectItem>)}
                            </SelectGroup>
                          )}
                          <SelectGroup>
                            <SelectLabel>Other</SelectLabel>
                            <SelectItem value={CLI_TOOL_SELECTION}>CLI utility</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeToolAccess(selectedToolIndex)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Permission</label>
                      <Select value={selectedTool.permission} onValueChange={(value) => updateSelectedTool({ permission: value as 'allow' | 'ask' | 'deny' })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="allow">Allow</SelectItem>
                          <SelectItem value="ask">Ask</SelectItem>
                          <SelectItem value="deny">Deny</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {selectedTool.type === 'cli' && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Command pattern</label>
                        <Input value={selectedTool.command || ''} placeholder="rg *" onChange={(event) => updateSelectedTool({ id: event.target.value, command: event.target.value })} />
                        <p className="text-xs text-muted-foreground">Use a supported CLI permission pattern, for example <code>rg *</code>.</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">Add a tool to configure agent access.</div>
                )}
              </div>

              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">Skills</div>
                    <p className="text-xs text-muted-foreground">Explain capabilities (such as tools) to the agent.</p>
                  </div>
                </div>
                <div className="min-w-0 flex gap-2 overflow-x-auto pb-1">
                  {skillAccess.map((skill, index) => (
                    <button
                      key={`${skill.id}-${index}`}
                      type="button"
                      onClick={() => setSelectedSkillIndex(index)}
                      className={`min-w-36 shrink-0 rounded-md border p-3 text-left text-sm transition-colors ${selectedSkillIndex === index ? 'border-primary bg-primary/10' : 'bg-card hover:bg-muted'}`}
                    >
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">{skill.source ?? 'manual'}</div>
                      <div className="truncate font-medium">{skill.id}</div>
                      <div className="text-xs text-muted-foreground">{skill.discovery}</div>
                    </button>
                  ))}
                  <button type="button" onClick={() => addSkillAccess()} className="min-w-24 shrink-0 rounded-md border border-dashed p-3 text-sm text-muted-foreground hover:bg-muted flex items-center justify-center">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>

                {selectedSkill ? (
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Skill</label>
                      {promptSkills.length > 0 ? (
                        <Select value={selectedSkill.id} onValueChange={(value) => updateSelectedSkill({ id: value })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {promptSkills.map(skill => <SelectItem key={skill.name} value={skill.name}>{skill.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input value={selectedSkill.id} onChange={(event) => updateSelectedSkill({ id: event.target.value })} />
                      )}
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Discovery</label>
                      <Select value={selectedSkill.discovery} onValueChange={(value) => updateSelectedSkill({ discovery: value as SkillDiscoveryMode })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="full">Full</SelectItem>
                          <SelectItem value="description">Description</SelectItem>
                          <SelectItem value="name">Name</SelectItem>
                          <SelectItem value="search">Search</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeSkillAccess(selectedSkillIndex)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    {selectedSkill.discovery === 'search' && <p className="text-xs text-amber-600 sm:col-span-3">Requires skill search tool availability at runtime.</p>}
                  </div>
                ) : (
                  <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">Add a skill to configure instruction discovery.</div>
                )}
              </div>

              <FormField
                control={form.control}
                name="disable"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Disable agent</FormLabel>
                      <FormDescription>
                        Prevent this agent from being used
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
            <div className="rounded-lg border bg-muted/30 p-3 lg:sticky lg:top-0 lg:max-h-[70vh] overflow-auto">
              <div className="mb-2 text-sm font-medium">Prompt Preview</div>
              <pre className="whitespace-pre-wrap break-words text-xs font-mono text-muted-foreground">{systemPromptValue.trim() || promptPreview}</pre>
            </div>
            </div>
          </Form>
        </div>

        <DialogFooter className="p-3 sm:p-4 border-t gap-2 pb-4">
          <Button variant="outline" onClick={() => handleOpenChange(false)} className="flex-1 sm:flex-none">
            Cancel
          </Button>
          <Button
            onClick={() => form.handleSubmit(handleSubmit)()}
            disabled={form.formState.isSubmitting}
            className="flex-1 sm:flex-none"
          >
            {editingAgent ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
