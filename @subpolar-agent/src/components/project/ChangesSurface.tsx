import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, CircleDot, FileDiff, GitBranch, Loader2, RefreshCw } from 'lucide-react'
import { fetchRepositoryDiff, fetchRepositoryStatus, getApiErrorMessage } from '@/api/git'
import type { RepositoryStatusRead } from '@/types/git'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ChangesSurfaceProps {
  projectId: string
}

type ChangeRow = RepositoryStatusRead['entries'][number] & {
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'
  staged: boolean
  unstaged: boolean
}

function statusFor(entry: RepositoryStatusRead['entries'][number]): ChangeRow['status'] {
  if (entry.untracked) return 'untracked'
  if (entry.renamed) return 'renamed'
  if (entry.index === 'C' || entry.worktree === 'C') return 'copied'
  if (entry.index === 'A' || entry.worktree === 'A') return 'added'
  if (entry.index === 'D' || entry.worktree === 'D') return 'deleted'
  return 'modified'
}

function changeRows(status: RepositoryStatusRead): ChangeRow[] {
  return status.entries.map((entry) => ({
    ...entry,
    status: statusFor(entry),
    staged: entry.index !== ' ' && !entry.untracked,
    unstaged: entry.worktree !== ' ' || entry.untracked,
  }))
}

const statusLabels: Record<ChangeRow['status'], string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  untracked: 'Untracked',
}

export function ChangesSurface({ projectId }: ChangesSurfaceProps) {
  const queryClient = useQueryClient()
  const [selectedPath, setSelectedPath] = useState<string>()
  const [staged, setStaged] = useState(false)
  const statusQuery = useQuery({
    queryKey: ['repositoryStatus', projectId],
    queryFn: () => fetchRepositoryStatus(projectId),
    enabled: Boolean(projectId),
  })
  const rows = statusQuery.data ? changeRows(statusQuery.data.status) : []
  const selected = rows.find((row) => row.path === selectedPath)
  const diffQuery = useQuery({
    queryKey: ['repositoryDiff', projectId, selectedPath, staged],
    queryFn: () => fetchRepositoryDiff(projectId, { path: selectedPath, staged }),
    enabled: Boolean(projectId && selectedPath),
  })

  useEffect(() => {
    if (selectedPath && rows.some((row) => row.path === selectedPath)) return
    setSelectedPath(rows[0]?.path)
    setStaged(Boolean(rows[0]?.staged && !rows[0]?.unstaged))
  }, [rows, selectedPath])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['repositoryStatus', projectId] })
    if (selectedPath) void queryClient.invalidateQueries({ queryKey: ['repositoryDiff', projectId, selectedPath] })
  }

  if (statusQuery.isLoading) {
    return <StateMessage label="Loading repository changes…" loading />
  }
  if (statusQuery.isError) {
    return <StateMessage label={getApiErrorMessage(statusQuery.error)} onRetry={() => void statusQuery.refetch()} />
  }
  if (!statusQuery.data) return <StateMessage label="Repository status is unavailable." onRetry={() => void statusQuery.refetch()} />

  const status = statusQuery.data.status
  const omitted = 'omitted' in status && Array.isArray(status.omitted) ? status.omitted as Array<{ path: string; reason: string }> : []
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-6" aria-label="Project changes">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Changes</h2>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1"><GitBranch className="h-4 w-4" />{status.branch ?? 'Detached HEAD'}</span>
            <span>{status.ahead} ahead</span><span>{status.behind} behind</span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} aria-label="Refresh changes">
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {status.truncated && <Notice>Some repository entries were truncated by the server.</Notice>}
      {omitted.length > 0 && <Notice>{omitted.length} path{omitted.length === 1 ? '' : 's'} omitted because access was denied.</Notice>}

      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-8 text-sm text-muted-foreground">Working tree is clean.</div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.5fr)]">
          <div className="min-h-0 overflow-auto rounded-lg border">
            <div className="border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Files ({rows.length})</div>
            <div className="divide-y">
              {rows.map((row) => (
                <button
                  key={`${row.path}:${row.index}:${row.worktree}`}
                  type="button"
                  onClick={() => { setSelectedPath(row.path); setStaged(Boolean(row.staged && !row.unstaged)) }}
                  className={cn('w-full px-3 py-3 text-left hover:bg-muted/50', selectedPath === row.path && 'bg-muted')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-sm" title={row.path}>{row.path}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{statusLabels[row.status]}</span>
                  </div>
                  <div className="mt-1 flex gap-2 text-xs text-muted-foreground">
                    {row.staged && <span className="inline-flex items-center gap-1"><Check className="h-3 w-3" /> Staged</span>}
                    {row.unstaged && <span className="inline-flex items-center gap-1"><CircleDot className="h-3 w-3" /> Unstaged</span>}
                  </div>
                  {row.originalPath && <div className="mt-1 truncate text-xs text-muted-foreground">from {row.originalPath}</div>}
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
            {selected ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2 font-mono text-sm"><FileDiff className="h-4 w-4 shrink-0" /> <span className="truncate">{selected.path}</span></span>
                  <div className="flex gap-1">
                    {selected.staged && <Button variant={!staged ? 'outline' : 'secondary'} size="sm" onClick={() => setStaged(true)}>Staged</Button>}
                    {selected.unstaged && <Button variant={staged ? 'outline' : 'secondary'} size="sm" onClick={() => setStaged(false)}>Working tree</Button>}
                  </div>
                </div>
                <DiffBody query={diffQuery} />
              </>
            ) : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Select a file to inspect its bounded diff.</div>}
          </div>
        </div>
      )}
    </section>
  )
}

function DiffBody({ query }: { query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchRepositoryDiff>>>> }) {
  if (query.isLoading) return <StateMessage label="Loading diff…" loading />
  if (query.isError) return <StateMessage label={getApiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
  if (!query.data) return <StateMessage label="Diff is unavailable." onRetry={() => void query.refetch()} />
  const diff = query.data.diff
  if (diff.binary) return <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">Binary file; no text diff is available.</div>
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/20 p-3">
      {diff.truncated && <Notice>Diff output was truncated to the server limit.</Notice>}
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">{diff.text || 'No textual changes for this view.'}</pre>
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"><AlertCircle className="h-4 w-4 shrink-0" />{children}</div>
}

function StateMessage({ label, loading, onRetry }: { label: string; loading?: boolean; onRetry?: () => void }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
    {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <AlertCircle className="h-5 w-5" />}
    <span>{label}</span>
    {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}
  </div>
}
