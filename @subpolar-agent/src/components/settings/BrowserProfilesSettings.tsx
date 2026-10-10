import { useEffect, useState } from 'react'
import { browserApi, type BrowserProfile } from '@/api/browser'
import { useAuthGeneration, useAuthOwner } from '@/stores/authIdentityStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LiveBrowser } from '@/components/agent-browser/LiveBrowser'
export function BrowserProfilesSettings() {
  const owner = useAuthOwner(), generation = useAuthGeneration()
  return <ProfileManager key={JSON.stringify([owner, generation])} />
}
function ProfileManager() {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]), [name, setName] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false), [openProfile, setOpenProfile] = useState<string>()
  const refresh = async () => setProfiles((await browserApi.profiles()).profiles)
  useEffect(() => { let active = true; void browserApi.profiles().then(r => active && setProfiles(r.profiles)).catch(e => active && setError(e.message)); return () => { active = false } }, [])
  useEffect(() => { if (!openProfile) return; let active = true; const timer = setInterval(() => { void browserApi.profiles().then(r => { if (active) setProfiles(r.profiles) }).catch(() => {}) }, 5000); return () => { active = false; clearInterval(timer) } }, [openProfile])
  async function run(action: () => Promise<unknown>) { setPending(true); setError(''); try { await action(); await refresh() } catch (e) { setError(e instanceof Error ? e.message : 'Profile operation failed') } finally { setPending(false) } }
  return <section className="space-y-4"><h2 className="text-xl font-semibold">Browser Profiles</h2><p className="text-sm text-muted-foreground">Persistent profiles retain website logins. Assign profiles individually in agent settings.</p>
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void run(async () => { await browserApi.createProfile(name.trim()); setName('') }) }}><Input aria-label="New profile name" value={name} maxLength={100} onChange={e => setName(e.target.value)} /><Button disabled={pending || !name.trim()}>Create profile</Button></form>
    {profiles.map(profile => <ProfileRow key={profile.id} profile={profile} pending={pending} run={run} open={() => setOpenProfile(profile.id)} />)}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {openProfile && <div className="h-[650px] rounded border"><Button variant="outline" onClick={() => setOpenProfile(undefined)}>Close viewer</Button><LiveBrowser initialProfileId={openProfile} /></div>}
  </section>
}
function ProfileRow({ profile, pending, run, open }: { profile: BrowserProfile; pending: boolean; run: (action: () => Promise<unknown>) => Promise<void>; open: () => void }) {
  const [name, setName] = useState(profile.name), [confirm, setConfirm] = useState<'clear' | 'delete'>()
  return <div className="flex flex-wrap items-center gap-2 rounded border p-3"><Input className="w-48" aria-label={`Rename ${profile.name}`} value={name} onChange={e => setName(e.target.value)} maxLength={100} /><span>{profile.busy ? 'In use' : 'Available'}</span><Button size="sm" disabled={pending || !name.trim() || name === profile.name} onClick={() => void run(() => browserApi.renameProfile(profile.id, name.trim()))}>Rename</Button><Button size="sm" disabled={pending || profile.busy} onClick={open}>Open to log in</Button><Button size="sm" variant="outline" disabled={pending || profile.busy} onClick={() => setConfirm('clear')}>Clear state</Button><Button size="sm" variant="outline" disabled={pending || profile.busy} onClick={() => setConfirm('delete')}>Delete</Button>{confirm && <div role="alert" className="w-full flex flex-wrap items-center gap-2"><span>{confirm === 'clear' ? 'Clear all website logins and browsing state?' : 'Delete this profile and all saved website state?'}</span><Button size="sm" variant="destructive" disabled={pending} onClick={() => void run(async () => { if (confirm === 'clear') await browserApi.clearProfile(profile.id); else await browserApi.deleteProfile(profile.id); setConfirm(undefined) })}>Confirm {confirm}</Button><Button size="sm" variant="outline" onClick={() => setConfirm(undefined)}>Cancel</Button></div>}</div>
}
