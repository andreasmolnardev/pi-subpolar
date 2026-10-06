import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { worktreesApi as api, type CreatedWorktree } from '@/api/worktrees'

const control = 'rounded border border-border px-3 py-2 text-sm disabled:opacity-50'
export function CreateWorktreeDialog({ sessionId, agent }: { sessionId: string; agent?: string }) {
  const [open, setOpen] = useState(false)
  return <>
    <button className={control} onClick={() => setOpen(true)}>New worktree</button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent><DialogTitle>Create worktree and session</DialogTitle>
        {open && <WorktreeForm sessionId={sessionId} agent={agent} close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  </>
}
function WorktreeForm({ sessionId, agent, close }: { sessionId: string; agent?: string; close: () => void }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['worktree-sources', sessionId], queryFn: () => api.sources(sessionId), retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const [ref, setRef] = useState('HEAD')
  const [branch, setBranch] = useState('')
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<CreatedWorktree>()
  const [remote, setRemote] = useState('')
  const data = query.data
  const source = data?.branches.find(item => item.ref === ref)
  const sha = ref === 'HEAD' ? data?.repository.head : source?.sha
  useEffect(() => { setApproved(false) }, [sha])
  async function refresh(fetchRemote = false) {
    if (!data) return
    setBusy(true); setError(''); setApproved(false)
    try {
      if (fetchRemote) await api.refreshRemote(data.repositoryId, remote)
      const result = await query.refetch()
      if (result.error) throw result.error
    } catch (e) { setError(e instanceof Error ? e.message : 'Refresh failed') }
    finally { setBusy(false) }
  }
  async function submit() {
    if (!created && (!data || !sha)) return
    setBusy(true); setError('')
    try {
      const checkout = created ?? await api.create(data!.repositoryId, { branch: branch.trim(), sourceRef: ref, expectedSha: sha!, approved })
      setCreated(checkout)
      const result = await api.createSession(checkout, agent)
      await Promise.all([client.invalidateQueries({ queryKey: ['projects'] }), client.invalidateQueries({ queryKey: ['sessions'] })])
      close()
      navigate(`/projects/${result.session.projectId}/sessions/${result.session.id}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Creation failed') }
    finally { setBusy(false) }
  }
  return <form className="grid gap-3" onSubmit={e => { e.preventDefault(); void submit() }}>
    <p className="text-sm text-muted-foreground">Creates a clean linked checkout and a new session. The current checkout, staged changes and untracked files are not copied or modified.</p>
    {query.isPending && <p role="status">Loading sources…</p>}
    {query.error && <p role="alert">{query.error.message}</p>}
    <fieldset disabled={busy || !!created} className="grid gap-3">
      <label className="grid gap-1 text-sm">Source reference
        <select className={control} value={ref} onChange={e => { setRef(e.target.value); setApproved(false) }}>
          <option value="HEAD">Current HEAD</option>
          <optgroup label="Local branches">{data?.branches.filter(item => !item.remote && !item.symbolic).map(item => <option key={item.ref} value={item.ref}>{item.name}{item.target ? ` (tracks ${item.target})` : ''}</option>)}</optgroup>
          <optgroup label="Remote-tracking branches (cached)">{data?.branches.filter(item => item.remote && !item.symbolic).map(item => <option key={item.ref} value={item.ref}>{item.name}</option>)}</optgroup>
        </select>
      </label>
      <p className="break-all font-mono text-xs">Commit: {sha ?? 'No commit available'}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={control} disabled={!data} onClick={() => void refresh()}>Refresh local references</button>
        <select aria-label="Remote to refresh" className={control} value={remote} onChange={e => setRemote(e.target.value)}><option value="">Select remote</option>{data?.remotes.map(name => <option key={name} value={name}>{name}</option>)}</select>
        <button type="button" className={control} disabled={!remote} onClick={() => void refresh(true)}>Fetch remote</button>
      </div>
      <p className="text-xs text-muted-foreground">Remote references are cached. Remote fetch is currently unsupported until a policy-aware authenticated Git transport is available. Local refresh only re-reads cached references. The selected source sets only the starting commit, not the new branch’s upstream.</p>
      <label className="grid gap-1 text-sm">New branch<input required className={control} value={branch} onChange={e => { setBranch(e.target.value); setApproved(false) }} placeholder="feature/my-change" /></label>
      <p className="text-xs text-muted-foreground">Tracking: none. Existing branch names are rejected, never reset.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />Approve creating this branch, linked repository and session at the displayed commit.</label>
    </fieldset>
    {created && <p role="status" className="break-all text-sm">Worktree created at {created.worktree.path}. Session creation can be retried without creating another checkout.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><button type="button" className={control} disabled={busy} onClick={close}>{created ? 'Keep worktree and close' : 'Cancel'}</button><button className={control} disabled={busy || (!created && (query.isFetching || !sha || !approved || !branch.trim()))}>{busy ? 'Working…' : created ? 'Retry new session' : 'Create worktree and session'}</button></div>
  </form>
}
