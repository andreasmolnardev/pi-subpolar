import { useState } from 'react'
import { settingsApi, type TeachToolDraft, type TeachToolKind, type TeachToolsResponse } from '@/api/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { showToast } from '@/lib/toast'

export function TeachToolsSettings() {
  const [kind, setKind] = useState<TeachToolKind>('cli')
  const [goal, setGoal] = useState('')
  const [command, setCommand] = useState('')
  const [fixedArgs, setFixedArgs] = useState('')
  const [cwd, setCwd] = useState('')
  const [serverConfig, setServerConfig] = useState('{}')
  const [openapiConfig, setOpenapiConfig] = useState('{}')
  const [result, setResult] = useState<TeachToolsResponse | null>(null)
  const [confirmedDrafts, setConfirmedDrafts] = useState<Set<number>>(() => new Set())
  const [registeredDrafts, setRegisteredDrafts] = useState<Set<number>>(() => new Set())
  const [isTeaching, setIsTeaching] = useState(false)
  const [savingDraft, setSavingDraft] = useState<number | null>(null)
  const [error, setError] = useState('')

  const handleTeach = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    let server: Record<string, unknown> | undefined
    let openapi: Record<string, unknown> | undefined
    try {
      if (kind === 'mcp') server = JSON.parse(serverConfig) as Record<string, unknown>
      if (kind === 'openapi') openapi = JSON.parse(openapiConfig) as Record<string, unknown>
    } catch {
      setError(kind === 'mcp' ? 'Server configuration must be valid JSON.' : 'OpenAPI configuration must be valid JSON.')
      return
    }

    setIsTeaching(true)
    setResult(null)
    setConfirmedDrafts(new Set())
    setRegisteredDrafts(new Set())
    try {
      const response = await settingsApi.teachTools({
        kind,
        goal: goal.trim(),
        ...(kind === 'cli' ? {
          command: command.trim(),
          fixedArgs: fixedArgs.split('\n').map((arg) => arg.trim()).filter(Boolean),
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        } : {}),
        ...(server ? { server } : {}),
        ...(openapi ? { openapi } : {}),
      })
      setResult(response)
    } catch (teachError) {
      setError(teachError instanceof Error ? teachError.message : 'Unable to teach tools. Please try again.')
    } finally {
      setIsTeaching(false)
    }
  }

  const handleRegister = async (draft: TeachToolDraft, index: number) => {
    if (!confirmedDrafts.has(index)) return
    setSavingDraft(index)
    setError('')
    try {
      await settingsApi.registerTool(draft)
      setRegisteredDrafts((current) => new Set(current).add(index))
      showToast.success(`Registered ${draft.tool_id}`)
    } catch (registerError) {
      setError(registerError instanceof Error ? registerError.message : `Unable to register ${draft.tool_id}.`)
    } finally {
      setSavingDraft(null)
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6" aria-labelledby="teach-tools-title">
      <header>
        <h2 id="teach-tools-title" className="text-xl font-semibold">Teach Tools</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe the tool you need and its source. Review every generated draft; nothing is registered until you confirm it.
        </p>
      </header>

      <form onSubmit={handleTeach} className="space-y-4 rounded-lg border bg-card p-4">
        <div className="space-y-2">
          <label htmlFor="teach-kind" className="text-sm font-medium">Source type</label>
          <select
            id="teach-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as TeachToolKind)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="cli">CLI</option>
            <option value="mcp">MCP</option>
            <option value="openapi">OpenAPI</option>
          </select>
        </div>

        <div className="space-y-2">
          <label htmlFor="teach-goal" className="text-sm font-medium">Goal</label>
          <Textarea
            id="teach-goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="What should the tool do?"
            required
            maxLength={4000}
          />
        </div>

        {kind === 'cli' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="teach-command" className="text-sm font-medium">Command</label>
              <Input id="teach-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="e.g. git" required />
              <p className="text-xs text-muted-foreground">Use an executable name only (no path or shell). Currently supported: bun, cargo, git, go, node, npm, pnpm, pytest, python, python3, rustc.</p>
            </div>
            <div className="space-y-2">
              <label htmlFor="teach-fixed-args" className="text-sm font-medium">Exploration arguments (optional)</label>
              <Textarea
                id="teach-fixed-args"
                value={fixedArgs}
                onChange={(event) => setFixedArgs(event.target.value)}
                placeholder={'One allowlisted help argument per line, for example:\n--help\n--version'}
                aria-describedby="teach-fixed-args-help"
              />
              <p id="teach-fixed-args-help" className="text-xs text-muted-foreground">Only help/version/list-style arguments are executed during exploration. The model drafts the registered command separately.</p>
            </div>
            <div className="space-y-2">
              <label htmlFor="teach-cwd" className="text-sm font-medium">Working directory (optional)</label>
              <Input id="teach-cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/path/to/project" />
            </div>
          </div>
        )}

        {kind === 'mcp' && (
          <div className="space-y-2">
            <label htmlFor="teach-server" className="text-sm font-medium">MCP server configuration (JSON)</label>
            <Textarea id="teach-server" value={serverConfig} onChange={(event) => setServerConfig(event.target.value)} className="font-mono text-sm" spellCheck={false} required />
          </div>
        )}

        {kind === 'openapi' && (
          <div className="space-y-2">
            <label htmlFor="teach-openapi" className="text-sm font-medium">OpenAPI source configuration (JSON)</label>
            <Textarea id="teach-openapi" value={openapiConfig} onChange={(event) => setOpenapiConfig(event.target.value)} className="font-mono text-sm" spellCheck={false} required />
          </div>
        )}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={isTeaching || !goal.trim() || (kind === 'cli' && !command.trim())}>
          {isTeaching ? 'Analyzing source…' : 'Generate tool drafts'}
        </Button>
      </form>

      {result && (
        <div className="space-y-6" aria-live="polite">
          <section className="space-y-2" aria-labelledby="teach-observations-title">
            <h3 id="teach-observations-title" className="text-lg font-semibold">Observations</h3>
            {result.observations.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {result.observations.map((observation, index) => <li key={`${index}-${observation}`}>{observation}</li>)}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No observations were returned.</p>}
          </section>

          <section className="space-y-3" aria-labelledby="teach-drafts-title">
            <h3 id="teach-drafts-title" className="text-lg font-semibold">Draft tools ({result.drafts.length})</h3>
            {result.drafts.length === 0 && <p className="text-sm text-muted-foreground">No tool drafts were generated.</p>}
            {result.drafts.map((draft, index) => {
              const confirmed = confirmedDrafts.has(index)
              const registered = registeredDrafts.has(index)
              return (
                <article key={`${draft.tool_id}-${index}`} className="space-y-3 rounded-lg border bg-card p-4">
                  <div>
                    <h4 className="font-semibold">{draft.tool_id}</h4>
                    <p className="text-sm text-muted-foreground">{draft.namespace} · {draft.adapter} · {draft.operation}</p>
                    <p className="mt-2 text-sm">{draft.description}</p>
                  </div>
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div><dt className="font-medium">Target</dt><dd className="break-all text-muted-foreground">{draft.target}</dd></div>
                    <div><dt className="font-medium">Risk</dt><dd className="text-muted-foreground">{draft.risk}</dd></div>
                    <div><dt className="font-medium">Approval required</dt><dd className="text-muted-foreground">{draft.requires_approval ? 'Yes' : 'No'}</dd></div>
                    <div><dt className="font-medium">Context mode</dt><dd className="text-muted-foreground">{draft.context_mode}</dd></div>
                  </dl>
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">Review schemas and metadata</summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">{JSON.stringify({ input_schema: draft.input_schema, output_schema: draft.output_schema, metadata: draft.metadata, enabled: draft.enabled }, null, 2)}</pre>
                  </details>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={registered || savingDraft === index}
                      onChange={(event) => setConfirmedDrafts((current) => {
                        const next = new Set(current)
                        if (event.target.checked) next.add(index)
                        else next.delete(index)
                        return next
                      })}
                      aria-label={`Confirm registration of ${draft.tool_id}`}
                    />
                    <span>I reviewed this draft and want to register it.</span>
                  </label>
                  <Button
                    type="button"
                    disabled={!confirmed || registered || savingDraft === index}
                    onClick={() => void handleRegister(draft, index)}
                  >
                    {registered ? 'Registered' : savingDraft === index ? 'Registering…' : 'Confirm and register tool'}
                  </Button>
                </article>
              )
            })}
          </section>
        </div>
      )}
    </section>
  )
}
