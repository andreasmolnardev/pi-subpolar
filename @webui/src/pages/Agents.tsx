import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { settingsApi, type AgentToolPolicyEffect } from '@/api/settings'
import { getProject } from '@/api/projects'
import { Header } from '@/components/ui/header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AgentDialog } from '@/components/settings/AgentDialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'
import type { AgentSkillAccess } from '@subpolar/shared'
import { Bot, Plus, Pencil, Trash2, ExternalLink } from 'lucide-react'
import { showToast } from '@/lib/toast'

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
  toolAccess?: Array<{ type: 'builtin' | 'skill' | 'cli' | 'subpolar'; id: string; permission: 'allow' | 'ask' | 'deny'; command?: string }>
  disable?: boolean
  sort_order?: number
  [key: string]: unknown
}

function policyEffect(permission: 'allow' | 'ask' | 'deny'): AgentToolPolicyEffect {
  if (permission === 'ask') return 'approval'
  return permission
}

function subpolarPolicies(agent: Agent) {
  const policies = (agent.toolAccess ?? [])
    .filter(tool => tool.type === 'subpolar')
    .map(tool => ({ toolId: tool.id, effect: policyEffect(tool.permission) }))
  const bashTool = (agent.toolAccess ?? []).find(tool => tool.type === 'builtin' && tool.id === 'other-bash')
  if (bashTool) policies.push({ toolId: 'pi.bash', effect: policyEffect(bashTool.permission) })
  if (policies.some(policy => policy.effect !== 'deny') && !policies.some(policy => policy.toolId === 'tools.list')) {
    return [{ toolId: 'tools.list', effect: 'allow' as const }, ...policies]
  }
  return policies
}

export function Agents() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: generalChatProject } = useQuery({
    queryKey: ['project', GENERAL_CHAT_PROJECT_ID],
    queryFn: () => getProject(GENERAL_CHAT_PROJECT_ID),
  })

  const generalChatDirectory = generalChatProject?.fullPath
  const { data: agentRecords = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => settingsApi.listAgents(),
  })

  const { data: subpolarSkills } = useQuery({
    queryKey: ['managed-skills', generalChatDirectory],
    queryFn: () => settingsApi.listManagedSkills(undefined, generalChatDirectory),
    enabled: !!generalChatDirectory,
    staleTime: 5 * 60 * 1000,
  })

  const agents = useMemo(() => {
    return Object.fromEntries(agentRecords.map((agent) => [agent.name, {
      ...agent,
      disable: !agent.enabled,
    }])) as Record<string, Agent>
  }, [agentRecords])
  const agentNames = useMemo(() => Object.keys(agents).filter((name) => !agents[name]?.disable), [agents])

  const [activeAgent, setActiveAgent] = useState('')
  const [editingAgent, setEditingAgent] = useState<{ name: string; agent: Agent } | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)

  useEffect(() => {
    if (!activeAgent && agentNames.length > 0) {
      setActiveAgent(agentNames[0])
    }
  }, [activeAgent, agentNames])

  const updateConfigMutation = useMutation({
    mutationFn: async ({ name, agent, id }: { name: string; agent: Agent; id?: string }) => {
      const request = {
        name,
        description: agent.description || '',
        mode: agent.mode === 'all' ? 'primary' as const : agent.mode || 'subagent' as const,
        prompt: agent.prompt || '',
        systemPrompt: agent.systemPrompt || '',
        permission: agent.permission || {},
        skills: agent.skills || [],
        skillAccess: agent.skillAccess || [],
        enabled: !agent.disable,
        sort_order: agent.sort_order || 0,
      }
      const savedAgent = id ? await settingsApi.updateAgent(id, request) : await settingsApi.createAgent(request)
      try {
        await settingsApi.replaceAgentToolPolicies(savedAgent.id, subpolarPolicies(agent))
      } catch {
        showToast.error('Agent saved, but its tool policies could not be saved')
      }
      return savedAgent
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agent-tool-policies'] })
    },
  })

  const handleCreate = async (name: string, agent: Agent) => {
    try {
      await updateConfigMutation.mutateAsync({ name, agent })
      setIsCreateOpen(false)
      setActiveAgent(name)
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Failed to create agent')
      throw error
    }
  }

  const handleDelete = (name: string) => {
    const agent = agents[name]
    if (!agent?.id) return
    settingsApi.deleteAgent(agent.id).then(() => queryClient.invalidateQueries({ queryKey: ['agents'] }))
    const remaining = Object.keys(agents).filter((n) => n !== name && !agents[n]?.disable)
    if (activeAgent === name) setActiveAgent(remaining[0] || '')
  }

  const handleUpdate = async (name: string, agent: Agent) => {
    try {
      await updateConfigMutation.mutateAsync({ id: agent.id, name, agent })
      setEditingAgent(null)
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Failed to update agent')
      throw error
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header>
        <Header.Title>Agents</Header.Title>
        <Header.Actions>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsCreateOpen(true)}
            className="gap-1"
          >
            <Plus className="h-4 w-4" />
            <span>Create</span>
          </Button>
        </Header.Actions>
      </Header>

      <div className="flex-1 flex flex-col min-h-0 p-4 pt-2">
        {agentNames.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Card>
              <CardContent className="p-8 text-center">
                <Bot className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-muted-foreground mb-4">No agents configured yet.</p>
                <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create your first agent
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Tabs value={activeAgent} onValueChange={setActiveAgent} className="flex flex-col min-h-0 flex-1">
            <TabsList className="w-full justify-start gap-1 overflow-x-auto flex-shrink-0">
              {agentNames.map((name) => {
                const agent = agents?.[name]
                const label = agent?.icon ? `${agent.icon} ${name}` : name
                return (
                  <TabsTrigger key={name} value={name} className="min-w-0">
                    <span className="truncate max-w-[120px]">{label}</span>
                  </TabsTrigger>
                )
              })}
            </TabsList>

            {agentNames.map((name) => {
              const agent = agents?.[name]
              if (!agent) return null
              return (
                <TabsContent key={name} value={name} className="flex-1 mt-4 overflow-y-auto">
                  <div className="max-w-3xl mx-auto space-y-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-lg">
                          {agent.icon || <Bot className="h-5 w-5 text-primary" />}
                        </div>
                        <div>
                          <h2 className="text-xl font-semibold">{name}</h2>
                          {agent.description && (
                            <p className="text-sm text-muted-foreground">{agent.description}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigate(`/repos/0?agent=${encodeURIComponent(name)}`)}
                          className="gap-1"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          <span>Use</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingAgent({ name, agent })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(name)}
                          className="text-red-500 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <InfoCard label="Mode" value={agent.mode || 'subagent'} />
                      <InfoCard label="Temperature" value={agent.temperature?.toString() || '0.7'} />
                      <InfoCard label="Top P" value={agent.topP?.toString() || agent.top_p?.toString() || '1'} />
                      <InfoCard
                        label="Status"
                        value={agent.disable ? 'Disabled' : 'Active'}
                        highlight={!agent.disable}
                      />
                    </div>

                    {agent.model && (
                      <div>
                        <h3 className="text-sm font-medium text-muted-foreground mb-1">Model</h3>
                        <p className="text-sm font-mono bg-muted rounded-md px-3 py-2">{agent.model}</p>
                      </div>
                    )}

                    <div>
                      <h3 className="text-sm font-medium text-muted-foreground mb-1">Tools</h3>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(agent.tools || {}).map(([tool, enabled]) => (
                          <span
                            key={tool}
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              enabled
                                ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>

                    {(agent.skillAccess?.length || agent.skills?.length) && (
                      <div>
                        <h3 className="text-sm font-medium text-muted-foreground mb-1">Skills</h3>
                        <div className="flex flex-wrap gap-2">
                          {(agent.skillAccess ?? agent.skills?.map((id) => ({ id, discovery: 'description' as const })) ?? []).map((skill) => (
                            <span
                              key={skill.id}
                              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400"
                            >
                              {skill.id}: {skill.discovery}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {agent.allowedCommands && agent.allowedCommands.length > 0 && (
                      <div>
                        <h3 className="text-sm font-medium text-muted-foreground mb-1">Allowed Commands</h3>
                        <div className="flex flex-wrap gap-2">
                          {agent.allowedCommands.map((cmd) => (
                            <span
                              key={cmd}
                              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400 font-mono"
                            >
                              {cmd}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {agent.permission && (
                      <div>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(agent.permission).map(([action, level]) => {
                            const colorMap: Record<string, string> = {
                              allow: 'bg-green-500/10 text-green-600 dark:text-green-400',
                              ask: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
                              deny: 'bg-red-500/10 text-red-600 dark:text-red-400',
                            }
                            const levelStr = typeof level === 'string' ? level : 'custom'
                            return (
                              <span
                                key={action}
                                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorMap[levelStr] || 'bg-muted text-muted-foreground'}`}
                              >
                                {action} permissions: {levelStr}
                              </span>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    <div>
                      <h3 className="text-sm font-medium text-muted-foreground mb-1">Prompt</h3>
                      <pre className="text-sm font-mono bg-muted rounded-md p-4 overflow-x-auto whitespace-pre-wrap">
                        {agent.prompt}
                      </pre>
                    </div>
                  </div>
                </TabsContent>
              )
            })}
          </Tabs>
        )}
      </div>

      <AgentDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={handleCreate}
        editingAgent={null}
        availableSkills={subpolarSkills || []}
      />

      <AgentDialog
        open={!!editingAgent}
        onOpenChange={() => setEditingAgent(null)}
        onSubmit={(name, agent) => {
          handleUpdate(name, { ...agent, id: editingAgent!.agent.id })
        }}
        editingAgent={editingAgent}
        availableSkills={subpolarSkills || []}
      />
    </div>
  )
}

function InfoCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-sm font-medium ${highlight ? 'text-green-600 dark:text-green-400' : ''}`}>
        {value}
      </p>
    </div>
  )
}
