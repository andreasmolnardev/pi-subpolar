import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, GitBranch, Loader2, RefreshCw } from 'lucide-react'
import { fetchRepositoryBranches, fetchRepositoryStatus, fetchRepositoryWorktrees, getApiErrorMessage } from '@/api/git'
import type { RepositoryBranchRead, RepositoryStatusRead, RepositoryWorktreeRead } from '@/types/git'
import { worktreesApi } from '@/api/worktrees'
import { gitProviderAccountsApi } from '@/api/git-provider-accounts'
import { gitProviderDataApi, type ProviderRepositoryMapping } from '@/api/git-provider-data'
import type { GitProviderAccount } from '@/api/git-provider-accounts'
import type { WorktreeProviderRepository } from '@/api/worktrees'
import { Button } from '@/components/ui/button'
import { useAuthGeneration, useAuthOwner } from '@/stores/authIdentityStore'
import { SUBPOLAR_API_BASE_URL } from '@/config'
import { useCreateSession } from '@/hooks/usePiHarness'
import { savePendingSessionPrompt } from '@/lib/pending-session-prompt'
import { addProviderContext, formatProviderContext } from './provider-context'

export interface RepositoryContextProps {
  sessionId: string
  projectRouteId?: string
  enabled: boolean
}

export function RepositoryContext({ sessionId, projectRouteId, enabled }: RepositoryContextProps) {
  const owner = useAuthOwner()
  const generation = useAuthGeneration()
  const queryKey = ['session-repository-context', owner, generation, sessionId, projectRouteId] as const
  const active = enabled && Boolean(projectRouteId) && projectRouteId !== '0'
  const source = useQuery({
    queryKey: [...queryKey, 'source'],
    queryFn: () => worktreesApi.sources(sessionId),
    enabled: active,
    retry: false,
    gcTime: 0,
  })
  const repositoryId = source.data?.repositoryId
  const repositoryKey = [...queryKey, repositoryId] as const
  const status = useQuery({
    queryKey: [...repositoryKey, 'status'],
    queryFn: () => fetchRepositoryStatus(repositoryId!),
    enabled: Boolean(repositoryId),
    retry: false,
    gcTime: 0,
  })
  const branches = useQuery({
    queryKey: [...repositoryKey, 'branches'],
    queryFn: () => fetchRepositoryBranches(repositoryId!),
    enabled: Boolean(repositoryId),
    retry: false,
    gcTime: 0,
  })
  const worktrees = useQuery({
    queryKey: [...repositoryKey, 'worktrees'],
    queryFn: () => fetchRepositoryWorktrees(repositoryId!),
    enabled: Boolean(repositoryId),
    retry: false,
    gcTime: 0,
  })

  if (!projectRouteId || projectRouteId === '0') {
    return <StateMessage label="This session is not linked to a project repository." />
  }
  if (!enabled) return <StateMessage label="Open Repository to inspect local Git state." />
  if (source.isPending) return <StateMessage label="Resolving owned repository…" loading />
  if (source.isError || !repositoryId) {
    return <StateMessage label={source.isError ? getApiErrorMessage(source.error) : 'This session is not linked to an owned repository.'} onRetry={() => void source.refetch()} />
  }
  if (status.isPending && branches.isPending && worktrees.isPending) {
    return <StateMessage label="Loading local repository state…" loading />
  }
  if (status.isError && branches.isError && worktrees.isError) {
    return <StateMessage label={getApiErrorMessage(status.error)} onRetry={() => { void status.refetch(); void branches.refetch(); void worktrees.refetch() }} />
  }

  const repository = status.data?.repository ?? branches.data?.repository ?? worktrees.data?.repository
  const current = status.data?.status
  const branchList = branches.data?.branches ?? []
  const treeList = worktrees.data?.worktrees ?? []
  return <div className="space-y-5 p-4">
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Local Git state</p>
      <p className="mt-1 text-xs text-muted-foreground">Local repository data is read-only. Provider browsing appears only when this repository has an explicit provider mapping and a connected account.</p>
    </div>

    {status.isError && <InlineError label={`Status unavailable: ${getApiErrorMessage(status.error)}`} onRetry={() => void status.refetch()} />}
    {branches.isError && <InlineError label={`Branches unavailable: ${getApiErrorMessage(branches.error)}`} onRetry={() => void branches.refetch()} />}
    {worktrees.isError && <InlineError label={`Worktrees unavailable: ${getApiErrorMessage(worktrees.error)}`} onRetry={() => void worktrees.refetch()} />}

    {repository && <section aria-label="Repository head" className="space-y-2">
      <h3 className="text-sm font-medium">Repository</h3>
      <div className="grid gap-2 rounded-md border border-border p-3 text-sm">
        <div className="flex items-center gap-2"><GitBranch className="h-4 w-4 text-muted-foreground" /><span>{current?.branch ?? 'Detached HEAD'}</span></div>
        <div><span className="text-muted-foreground">HEAD: </span><code className="break-all">{repository.head ?? 'No commit yet'}</code></div>
        {current && <div className="flex gap-4 text-muted-foreground"><span>{current.ahead} ahead</span><span>{current.behind} behind</span><span>{current.entries.length} dirty {current.entries.length === 1 ? 'file' : 'files'}</span></div>}
      </div>
      {current && <LocalChanges status={current} />}
    </section>}

    <section aria-label="Local refs" className="space-y-2">
      <h3 className="text-sm font-medium">Local refs ({branchList.length})</h3>
      {branches.isPending ? <p className="text-sm text-muted-foreground">Loading refs…</p> : branchList.length ? <ul className="divide-y rounded-md border border-border">
        {branchList.map((branch) => <BranchRow key={branch.ref} branch={branch} branches={branchList} />)}
      </ul> : !branches.isError ? <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No local or remote-tracking refs are available.</p> : null}
    </section>

    <section aria-label="Worktrees" className="space-y-2">
      <h3 className="text-sm font-medium">Worktrees ({treeList.length})</h3>
      {worktrees.isPending ? <p className="text-sm text-muted-foreground">Loading worktrees…</p> : treeList.length ? <ul className="divide-y rounded-md border border-border">
        {treeList.map((worktree) => <WorktreeRow key={`${worktree.path}:${worktree.head}`} worktree={worktree} />)}
      </ul> : !worktrees.isError ? <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No worktrees are available.</p> : null}
    </section>

    <ProviderBrowser identity={source.data.providerRepository} owner={owner} generation={generation} />
  </div>
}

export function matchingProviderAccounts(accounts: GitProviderAccount[], provider?: WorktreeProviderRepository['provider']) {
  return provider ? accounts.filter(account => account.provider === provider && account.status === 'connected') : []
}

export function ProviderBrowserPanel({ sessionId, projectRouteId, enabled }: { sessionId: string; projectRouteId?: string; enabled: boolean }) {
  const owner = useAuthOwner()
  const generation = useAuthGeneration()
  const source = useQuery({
    queryKey: ['session-repository-context', owner, generation, sessionId, projectRouteId, 'source'],
    queryFn: () => worktreesApi.sources(sessionId),
    enabled: enabled && Boolean(projectRouteId) && projectRouteId !== '0',
    retry: false,
    gcTime: 0,
  })
  if (!projectRouteId || projectRouteId === '0') return <StateMessage label="This session is not linked to a project repository." />
  if (!enabled) return <StateMessage label="Open Browser to browse provider issues and pull requests." />
  if (source.isPending) return <StateMessage label="Resolving owned repository…" loading />
  if (source.isError || !source.data) return <StateMessage label={source.isError ? getApiErrorMessage(source.error) : 'This session is not linked to an owned repository.'} onRetry={() => void source.refetch()} />
  return <div className="p-4"><ProviderBrowser identity={source.data.providerRepository} owner={owner} generation={generation} projectRouteId={projectRouteId} /></div>
}

function ProviderBrowser({ identity, owner, generation, projectRouteId }: { identity?: WorktreeProviderRepository; owner: string | null; generation: number; projectRouteId?: string }) {
  const [view, setView] = useState<'branches' | 'issues' | 'pulls'>('issues')
  const [selection, setSelection] = useState<{ identityKey: string; accountId: string }>()
  const accounts = useQuery({
    queryKey: ['git-provider-accounts', owner, generation],
    queryFn: gitProviderAccountsApi.list,
    enabled: Boolean(identity?.owner && identity.repo),
    retry: false,
    gcTime: 0,
  })
  const candidates = matchingProviderAccounts(accounts.data?.accounts ?? [], identity?.provider)
  const identityKey = identity ? `${identity.remote}:${identity.provider}:${identity.owner}/${identity.repo}` : ''
  const selectedCandidate = candidates.length === 1 ? candidates[0] : candidates.find(item => item.id === selection?.accountId && selection.identityKey === identityKey)
  const account = selectedCandidate
  const mapping: ProviderRepositoryMapping | undefined = account && identity ? { accountId: account.id, owner: identity.owner, repo: identity.repo } : undefined
  const scopedKey = ['provider-repository', owner, generation, mapping?.accountId, mapping?.owner, mapping?.repo] as const
  const active = Boolean(account && mapping)
  const repository = useQuery({ queryKey: [...scopedKey, 'repository'], queryFn: () => gitProviderDataApi.repository(mapping!), enabled: active, retry: false, gcTime: 0 })
  const branches = useQuery({ queryKey: [...scopedKey, 'branches'], queryFn: () => gitProviderDataApi.branches(mapping!), enabled: active && view === 'branches', retry: false, gcTime: 0 })
  const issues = useQuery({ queryKey: [...scopedKey, 'issues'], queryFn: () => gitProviderDataApi.issues(mapping!), enabled: active && view === 'issues', retry: false, gcTime: 0 })
  const pulls = useQuery({ queryKey: [...scopedKey, 'pulls'], queryFn: () => gitProviderDataApi.pulls(mapping!), enabled: active && view === 'pulls', retry: false, gcTime: 0 })
  const [selectedIssue, setSelectedIssue] = useState<number>()
  const [selectedPullNumber, setSelectedPullNumber] = useState<number>()
  const issueNumber = issues.data?.issues.find(item => item.number === selectedIssue)?.number
  const comments = useQuery({ queryKey: [...scopedKey, 'issue-comments', issueNumber], queryFn: () => gitProviderDataApi.comments(mapping!, issueNumber!), enabled: active && issueNumber !== undefined, retry: false, gcTime: 0 })
  const pullItems = pulls.data?.pulls ?? []
  const selectedPull = pullItems.find(item => item.number === selectedPullNumber) ?? pullItems[0]
  const pullHead = selectedPull?.headSha ?? undefined
  const checks = useQuery({ queryKey: [...scopedKey, 'checks', pullHead], queryFn: () => gitProviderDataApi.statuses(mapping!, pullHead!), enabled: active && view === 'pulls' && Boolean(pullHead), retry: false, gcTime: 0 })
  const pullNumber = selectedPull?.number
  const pullComments = useQuery({ queryKey: [...scopedKey, 'pull-comments', pullNumber], queryFn: () => gitProviderDataApi.comments(mapping!, pullNumber!), enabled: active && view === 'pulls' && pullNumber !== undefined, retry: false, gcTime: 0 })
  const navigate = useNavigate()
  const createSession = useCreateSession(SUBPOLAR_API_BASE_URL)
  function addIssueContext(issue: { number: number; title: string; body?: string | null; htmlUrl?: string }) {
    addProviderContext({
      title: `Issue #${issue.number}: ${issue.title}`,
      body: issue.body ?? 'No issue description.',
      ...(issue.htmlUrl ? { url: issue.htmlUrl } : {}),
    })
  }
  async function startSessionFromIssue(issue: { number: number; title: string; body?: string | null; htmlUrl?: string }) {
    if (!projectRouteId || projectRouteId === '0') return
    const prompt = `Please help me work on this issue.\n\n${formatProviderContext({
      title: `Issue #${issue.number}: ${issue.title}`,
      body: issue.body ?? 'No issue description.',
      ...(issue.htmlUrl ? { url: issue.htmlUrl } : {}),
    })}`
    try {
      const project = /^\d+$/.test(projectRouteId) ? Number(projectRouteId) : projectRouteId
      const session = await createSession.mutateAsync({ project, title: `Issue #${issue.number}: ${issue.title}`, permission: 'ask' })
      const pendingPrompt = { prompt, messageID: crypto.randomUUID(), permission: 'ask' }
      savePendingSessionPrompt(session.id, pendingPrompt)
      navigate(`/projects/${encodeURIComponent(projectRouteId)}/sessions/${encodeURIComponent(session.id)}`, { state: { pendingPrompt } })
    } catch {
      // useCreateSession reports the request error through the shared toast path.
    }
  }

  if (!identity?.owner || !identity.repo) return <section aria-label="Provider repository" className="space-y-2"><h3 className="text-sm font-medium">Provider issues and pull requests</h3><p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Unavailable: no supported GitHub or Gitea remote identity was found. Workspace display paths are not used to infer a repository.</p></section>
  if (accounts.isPending) return <p className="text-sm text-muted-foreground">Checking connected provider account…</p>
  if (accounts.isError) return <InlineError label={`Provider accounts unavailable: ${getApiErrorMessage(accounts.error)}`} onRetry={() => void accounts.refetch()} />
  if (!candidates.length) return <section aria-label="Provider repository" className="space-y-2"><h3 className="text-sm font-medium">Provider issues and pull requests</h3><p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Unavailable: no connected {identity.provider} account is available for this repository.</p></section>
  if (!account || !mapping) return <section aria-label="Provider repository" className="space-y-2"><h3 className="text-sm font-medium">Provider issues and pull requests</h3><label className="grid max-w-sm gap-1 text-sm">Choose a connected {identity.provider} account<select aria-label="Provider account" className="rounded-md border border-input bg-background px-3 py-2" value={selection?.identityKey === identityKey ? selection.accountId : ''} onChange={event => setSelection({ identityKey, accountId: event.target.value })}><option value="">Select an account</option>{candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}</select></label></section>

  const tabs = [{ id: 'branches', label: 'Provider branches' }, { id: 'issues', label: 'Issues' }, { id: 'pulls', label: 'Pull requests' }] as const
  const listError = view === 'branches' ? branches.error : view === 'issues' ? issues.error : pulls.error
  const listPending = view === 'branches' ? branches.isPending : view === 'issues' ? issues.isPending : pulls.isPending
  return <section aria-label="Provider repository" className="space-y-3 border-t border-border pt-4">
    <div><h3 className="text-sm font-medium">Provider repository</h3><p className="text-xs text-muted-foreground">{account.displayName} · {mapping.owner}/{mapping.repo} · read-only</p></div>
    {repository.isError && <InlineError label={`Provider repository details unavailable: ${getApiErrorMessage(repository.error)}`} onRetry={() => void repository.refetch()} />}
    {repository.data?.repository && <p className="text-xs text-muted-foreground">{typeof repository.data.repository.description === 'string' ? `${repository.data.repository.description.slice(0, CONTENT_LIMIT)}${repository.data.repository.description.length > CONTENT_LIMIT ? '… (content truncated)' : ''}` : 'Provider repository details loaded.'}</p>}
    <div className="flex flex-wrap gap-2">{tabs.map(tab => <Button key={tab.id} size="sm" variant={view === tab.id ? 'default' : 'outline'} onClick={() => setView(tab.id)}>{tab.label}</Button>)}</div>
    {listError && <InlineError label={getApiErrorMessage(listError)} onRetry={() => { if (view === 'branches') void branches.refetch(); else if (view === 'issues') void issues.refetch(); else void pulls.refetch() }} />}
    {listPending ? <p className="text-sm text-muted-foreground">Loading provider {view}…</p> : view === 'branches' ? <ProviderBranches items={branches.data?.branches ?? []} /> : view === 'issues' ? <ProviderIssues items={issues.data?.issues ?? []} selected={selectedIssue} onSelect={setSelectedIssue} comments={comments.data?.comments ?? []} commentsLoading={comments.isPending} commentsError={comments.isError ? getApiErrorMessage(comments.error) : undefined} onAddContext={addIssueContext} onStartSession={startSessionFromIssue} startPending={createSession.isPending} /> : <ProviderPulls items={pullItems} selected={selectedPull?.number} onSelect={setSelectedPullNumber} checks={checks.data?.statuses} checksError={checks.isError ? getApiErrorMessage(checks.error) : undefined} checksLoading={checks.isPending && Boolean(pullHead)} comments={pullComments.data?.comments ?? []} commentsError={pullComments.isError ? getApiErrorMessage(pullComments.error) : undefined} commentsLoading={pullComments.isPending} />}
  </section>
}

const CONTENT_LIMIT = 3000
const PREVIEW_LIMIT = 20
function CappedText({ value }: { value?: string | null }) { return <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{value ? `${value.slice(0, CONTENT_LIMIT)}${value.length > CONTENT_LIMIT ? '… (content truncated)' : ''}` : 'No description.'}</p> }
function ProviderBranches({ items }: { items: Readonly<Record<string, unknown>>[] }) {
  return items.length ? <ul className="max-h-80 divide-y overflow-auto rounded-md border">{items.slice(0, PREVIEW_LIMIT).map((item, index) => <li key={String(item.name ?? item.ref ?? index)} className="break-all px-3 py-2 text-xs">{String(item.name ?? item.ref ?? 'Unnamed branch')}{typeof item.sha === 'string' ? ` · ${item.sha}` : ''}</li>)}</ul> : <p className="text-sm text-muted-foreground">No provider branches.</p>
}
function ProviderIssues({ items, selected, onSelect, comments, commentsLoading, commentsError, onAddContext, onStartSession, startPending }: { items: { number: number; title: string; state: string; body?: string | null; htmlUrl?: string }[]; selected?: number; onSelect: (number: number) => void; comments: { body?: string | null; user?: { login?: string } | string; createdAt?: string }[]; commentsLoading: boolean; commentsError?: string; onAddContext: (issue: { number: number; title: string; body?: string | null; htmlUrl?: string }) => void; onStartSession: (issue: { number: number; title: string; body?: string | null; htmlUrl?: string }) => void; startPending: boolean }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">No provider issues.</p>
  return <ul className="max-h-[32rem] divide-y overflow-auto rounded-md border">{items.slice(0, PREVIEW_LIMIT).map(issue => <li key={issue.number} className="space-y-2 p-3"><button className="text-left text-sm font-medium hover:underline" onClick={() => onSelect(issue.number)}>#{issue.number} {issue.title} <span className="text-xs font-normal text-muted-foreground">· {issue.state}</span></button><CappedText value={issue.body} /><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => onAddContext(issue)}>Add to context</Button><Button size="sm" variant="outline" disabled={startPending} onClick={() => onStartSession(issue)}>{startPending ? 'Starting session…' : 'Start session from issue'}</Button></div>{selected === issue.number && <div className="space-y-2 border-t pt-2"><p className="text-xs font-medium">Comments</p>{commentsLoading ? <p className="text-xs text-muted-foreground">Loading comments…</p> : commentsError ? <p role="alert" className="text-xs text-destructive">Comments unavailable: {commentsError}</p> : comments.length ? comments.slice(0, PREVIEW_LIMIT).map((comment, index) => <div key={index} className="rounded bg-muted/40 p-2"><p className="text-xs font-medium">{typeof comment.user === 'string' ? comment.user : comment.user?.login ?? 'Provider user'}{comment.createdAt ? ` · ${comment.createdAt}` : ''}</p><CappedText value={comment.body} /></div>) : <p className="text-xs text-muted-foreground">No comments.</p>}</div>}</li>)}</ul>
}
function ProviderPulls({ items, selected, onSelect, checks, checksError, checksLoading, comments, commentsError, commentsLoading }: { items: { number: number; title: string; state: string; body?: string | null; base?: string | { ref?: string }; head?: string | { ref?: string; sha?: string }; headSha?: string | null }[]; selected?: number; onSelect: (number: number) => void; checks?: Readonly<Record<string, unknown>>[]; checksError?: string; checksLoading: boolean; comments: { body?: string | null; user?: { login?: string } | string; createdAt?: string }[]; commentsError?: string; commentsLoading: boolean }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">No provider pull requests.</p>
  return <ul className="max-h-[32rem] divide-y overflow-auto rounded-md border">{items.slice(0, PREVIEW_LIMIT).map(pull => {
    const base = typeof pull.base === 'string' ? pull.base : pull.base?.ref
    const head = typeof pull.head === 'string' ? pull.head : pull.head?.ref
    return <li key={pull.number} className="space-y-2 p-3">
      <button className="text-left text-sm font-medium hover:underline" onClick={() => onSelect(pull.number)}>#{pull.number} {pull.title} <span className="text-xs font-normal text-muted-foreground">· {pull.state}</span></button>
      <p className="break-all text-xs text-muted-foreground">{base ?? 'base unavailable'} ← {head ?? 'head unavailable'}</p>
      <CappedText value={pull.body} />
      {selected === pull.number && <div className="space-y-2 border-t pt-2 text-xs">
        {pullHeadSha(pull) && <section><p className="font-medium">Checks</p>{checksLoading ? <p className="text-muted-foreground">Loading check results…</p> : checksError ? <p role="alert" className="text-destructive">Checks unavailable: {checksError}</p> : checks ? checks.length ? checks.slice(0, PREVIEW_LIMIT).map((check, index) => <p key={index}>{String(check.context ?? check.name ?? 'Check')}: {String(check.state ?? check.status ?? 'result unavailable')}</p>) : <p className="text-muted-foreground">No check results.</p> : <p className="text-muted-foreground">Check results were not returned.</p>}</section>}
        <section className="space-y-1"><p className="font-medium">Discussion</p>{commentsLoading ? <p className="text-muted-foreground">Loading discussion…</p> : commentsError ? <p role="alert" className="text-destructive">Discussion unavailable: {commentsError}</p> : comments.length ? comments.slice(0, PREVIEW_LIMIT).map((comment, index) => <div key={index} className="rounded bg-muted/40 p-2"><p className="font-medium">{typeof comment.user === 'string' ? comment.user : comment.user?.login ?? 'Provider user'}{comment.createdAt ? ` · ${comment.createdAt}` : ''}</p><CappedText value={comment.body} /></div>) : <p className="text-muted-foreground">No discussion comments.</p>}</section>
      </div>}
    </li>
  })}</ul>
}
function pullHeadSha(pull: { head?: string | { sha?: string }; headSha?: string | null }) { return pull.headSha ?? (typeof pull.head === 'string' ? undefined : pull.head?.sha) }

function LocalChanges({ status }: { status: RepositoryStatusRead }) {
  if (!status.entries.length) return <p className="text-sm text-muted-foreground">Working tree is clean.</p>
  return <ul aria-label="Dirty files" className="max-h-56 divide-y overflow-auto rounded-md border border-border">
    {status.entries.map((entry) => <li key={`${entry.path}:${entry.index}:${entry.worktree}`} className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
      <code className="min-w-0 break-all">{entry.path}{entry.originalPath ? ` ← ${entry.originalPath}` : ''}</code>
      <span className="shrink-0 text-muted-foreground">{entry.untracked ? 'Untracked' : `${entry.index}${entry.worktree}`}</span>
    </li>)}
    {status.omitted.length > 0 && <li className="px-3 py-2 text-xs text-muted-foreground">{status.omitted.length} path(s) omitted by repository access policy.</li>}
    {status.truncated && <li className="px-3 py-2 text-xs text-muted-foreground">Status results were truncated.</li>}
  </ul>
}

function BranchRow({ branch, branches }: { branch: RepositoryBranchRead; branches: RepositoryBranchRead[] }) {
  const base = branch.target ? branches.find(ref => ref.name === branch.target || ref.ref === branch.target) : undefined
  return <li className="space-y-1 px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2"><code className="break-all">{branch.name}</code>{branch.current && <span className="rounded bg-muted px-1.5 py-0.5">current</span>}{branch.remote && <span className="text-muted-foreground">remote-tracking</span>}</div>
    <p className="break-all text-muted-foreground">{branch.ref}{branch.target ? ` · upstream/base ${branch.target}` : ''}</p>
    {branch.sha && <p className="break-all text-muted-foreground">SHA {branch.sha}</p>}
    {base?.sha && <p className="break-all text-muted-foreground">Base SHA {base.sha}</p>}
  </li>
}

function WorktreeRow({ worktree }: { worktree: RepositoryWorktreeRead }) {
  return <li className="space-y-1 px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2"><code className="break-all">{worktree.path}</code>{worktree.detached && <span className="text-muted-foreground">detached</span>}{worktree.locked && <span className="text-muted-foreground">locked</span>}{worktree.prunable && <span className="text-muted-foreground">prunable</span>}</div>
    <p className="break-all text-muted-foreground">{worktree.branch ?? 'No branch'} · HEAD {worktree.head ?? 'unavailable'}</p>
  </li>
}

function InlineError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 p-3 text-sm">
    <span>{label}</span><Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="h-3.5 w-3.5" /> Retry</Button>
  </div>
}

function StateMessage({ label, loading, onRetry }: { label: string; loading?: boolean; onRetry?: () => void }) {
  return <div role={loading ? undefined : 'alert'} className="flex min-h-40 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
    {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <AlertCircle className="h-5 w-5" />}
    <span>{label}</span>
    {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}
  </div>
}
