import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { sessionWorkspaceApi as api, type SessionWorkspace, type WorkspaceGroup } from '@/api/session-workspace'
import { control, input, WorkspaceError } from './shared'
import { useAuthGeneration, useAuthOwner } from '@/stores/authIdentityStore'

export function WorkspaceReview({ sessionId, workspace, refresh, commitFocus }: {
  sessionId: string; workspace: SessionWorkspace; refresh: () => Promise<unknown>; commitFocus: boolean
}) {
  const owner = useAuthOwner()
  const generation = useAuthGeneration()
  const [selected, setSelected] = useState('')
  const [destination, setDestination] = useState('')
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string; message: string } | null>(null)
  const [confirm, setConfirm] = useState<WorkspaceGroup | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const groupId = workspace.groups.some(g => g.id === destination) ? destination : workspace.groups[0]?.id ?? ''
  const paths = [...new Set([...workspace.files.map(f => f.path), ...workspace.groups.flatMap(g => g.paths)])]
  const path = paths.includes(selected) ? selected : paths[0] ?? ''
  const diff = useQuery({ queryKey: ['session-workspace-diff', sessionId, owner, generation, path], queryFn: () => api.diff(sessionId, path), enabled: !!path, retry: false })
  async function mutate(action: () => Promise<unknown>, success?: () => void) {
    if (pending) return
    setPending(true); setError(null)
    try { await action(); success?.(); await refresh() } catch (e) { setError(e) } finally { setPending(false) }
  }
  function fileRow(filePath: string) {
    const file = workspace.files.find(f => f.path === filePath)
    const staged = workspace.groups.find(g => g.paths.includes(filePath))
    return <div key={filePath} className="flex flex-wrap items-center gap-2 border-b border-border py-2">
      <button className={`${control} min-w-0 flex-1 text-left break-all ${path === filePath ? 'bg-muted' : ''}`} aria-pressed={path === filePath} onClick={() => setSelected(filePath)}>{filePath}</button>
      {file && <span className="text-xs text-muted-foreground">{file.status} {file.binary ? 'binary' : <><span className="text-green-600 dark:text-green-400">+{file.additions}</span> <span className="text-red-600 dark:text-red-400">−{file.deletions}</span></>}</span>}
      <button className={control} disabled={pending || !groupId} onClick={() => void mutate(() => api.stage(sessionId, filePath, groupId))}>{staged ? staged.id === groupId ? 'Restage' : 'Move' : 'Stage'}</button>
      {staged && <button className={control} disabled={pending} onClick={() => void mutate(() => api.unstage(sessionId, filePath))}>Unstage</button>}
    </div>
  }
  return <div className="space-y-4 p-4">
    <p className="text-xs text-muted-foreground">{workspace.isGit ? `Worktree changes against Git HEAD${workspace.branch ? ` · ${workspace.branch}` : ''}. Includes pre-existing changes, not agent attribution.` : 'Workspace changes against the server baseline.'}</p>
    {commitFocus && <p role="status" className="rounded-md bg-muted p-3 text-sm">Review files, stage snapshots into an area, and set its commit message. Commit requires a separate confirmation.</p>}
    <WorkspaceError error={error} />
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-sm" htmlFor={`destination-${sessionId}`}>Staging destination</label>
      <select id={`destination-${sessionId}`} className={control} value={groupId} onChange={e => setDestination(e.target.value)} disabled={pending || !workspace.groups.length}>
        {!workspace.groups.length && <option value="">Create an area first</option>}
        {workspace.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
    </div>
    <section aria-label="Changed files"><h3 className="text-sm font-medium">Changed files ({workspace.files.length})</h3>{workspace.files.length ? workspace.files.map(f => fileRow(f.path)) : <p className="py-3 text-sm text-muted-foreground">No worktree changes.</p>}</section>
    {path && <section aria-label={`Diff for ${path}`}>
      <h3 className="mb-2 break-all text-sm font-medium">{path} · current worktree diff</h3>
      <WorkspaceError error={diff.error} retry={() => void diff.refetch()} />
      {diff.isPending ? <p role="status">Loading diff…</p> : diff.data?.binary ? <p className="text-sm text-muted-foreground">Binary file; no text diff is available.</p> : <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 text-xs" tabIndex={0} aria-label="File diff">{diff.data?.text ? diff.data.text.split('\n').map((line, i) => <div key={i} className={`min-h-4 whitespace-pre px-2 ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-green-500/10 text-green-700 dark:text-green-300' : line.startsWith('-') && !line.startsWith('---') ? 'bg-red-500/10 text-red-700 dark:text-red-300' : ''}`}>{line || ' '}</div>) : 'No text changes.'}</pre>}
    </section>}
    <section aria-label="Staged areas" className="space-y-3">
      <h3 className="font-medium">Staged areas</h3>
      <p className="text-xs text-muted-foreground">Areas hold snapshots, not the Git index. Stage, Restage, or Move captures the current file. Diffs above show the worktree, not the saved snapshot.</p>
      {workspace.groups.map(g => <div key={g.id} className="rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button className={control} onClick={() => setEditing({ id: g.id, name: g.name, message: g.message })} disabled={pending} aria-label={`Edit ${g.name}`}>{g.name} ({g.paths.length})</button>
          {workspace.isGit && <button className={control} disabled={pending || !g.paths.length || !g.message.trim()} onClick={() => setConfirm(g)}>Commit area</button>}
        </div>
        <p className="my-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{g.message || 'Click the area name to set a commit message.'}</p>
        {g.paths.map(fileRow)}
      </div>)}
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void mutate(async () => { const g = await api.createGroup(sessionId, newName.trim()); setDestination(g.id) }, () => setNewName('')) }}>
        <input className={input} aria-label="New area name" placeholder="New staging area" maxLength={200} value={newName} onChange={e => setNewName(e.target.value)} disabled={pending} />
        <button className={control} disabled={pending || !newName.trim()}>Create area</button>
      </form>
    </section>
    {editing && <form aria-label="Edit staging area" className="space-y-2 rounded-md border border-border p-3" onSubmit={e => { e.preventDefault(); void mutate(() => api.updateGroup(sessionId, editing.id, { name: editing.name.trim(), message: editing.message }), () => setEditing(null)) }}>
      <label className="block text-sm">Area name<input autoFocus className={input} maxLength={200} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} disabled={pending} /></label>
      <label className="block text-sm">Commit message<textarea className={input} rows={4} maxLength={4096} value={editing.message} onChange={e => setEditing({ ...editing, message: e.target.value })} disabled={pending} /></label>
      <button className={control} disabled={pending || !editing.name.trim()}>Save area</button> <button type="button" className={control} disabled={pending} onClick={() => setEditing(null)}>Cancel</button>
    </form>}
    {confirm && <section role="region" aria-label="Confirm commit" className="space-y-2 rounded-md border border-border bg-muted p-3">
      <h3 className="font-medium">Commit {confirm.name}?</h3>
      <p className="text-sm">Only the {confirm.paths.length} saved snapshots in this area will be committed. Later worktree edits are not included.</p>
      <pre className="whitespace-pre-wrap break-words text-sm">{confirm.message}</pre>
      <ul className="text-xs break-all">{confirm.paths.map(p => <li key={p}>{p}</li>)}</ul>
      <button className={control} disabled={pending} onClick={() => void mutate(() => api.commit(sessionId, confirm.id), () => setConfirm(null))}>{pending ? 'Committing…' : 'Confirm commit'}</button> <button className={control} disabled={pending} onClick={() => setConfirm(null)}>Cancel</button>
    </section>}
  </div>
}
