import { useEffect, useState } from 'react'
import { browserApi, type BrowserConfiguration, type BrowserProfile } from '@/api/browser'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
export function AgentBrowserSettings({ allowed, configuration, onChange }: { allowed: boolean; configuration: BrowserConfiguration; onChange: (allowed: boolean, configuration: BrowserConfiguration) => void }) {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]), [name, setName] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false)
  const manageUrl = new URL(window.location.href); manageUrl.searchParams.set('settings', 'open'); manageUrl.searchParams.set('settingsTab', 'browser-profiles')
  useEffect(() => { let active = true; void browserApi.profiles().then(r => active && setProfiles(r.profiles)).catch(e => active && setError(e.message)); return () => { active = false } }, [])
  function assign(id: string, checked: boolean) { const ids = checked ? [...configuration.allowedProfileIds, id] : configuration.allowedProfileIds.filter(x => x !== id); onChange(allowed, { ...configuration, allowedProfileIds: ids, defaultProfileId: ids.includes(configuration.defaultProfileId ?? '') ? configuration.defaultProfileId : undefined }) }
  return <section className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">Tools → Browser</h3><label className="flex items-center justify-between">Allow browser tool<Switch checked={allowed} onCheckedChange={value => onChange(value, configuration)} /></label><p className="text-xs text-muted-foreground">Only selected profiles are available to this agent. Tool approval rules still apply.</p>
    {profiles.map(profile => <label key={profile.id} className="flex items-center gap-2"><input type="checkbox" checked={configuration.allowedProfileIds.includes(profile.id)} onChange={e => assign(profile.id, e.target.checked)} />{profile.name}{profile.busy && ' (in use)'}</label>)}
    <label className="flex items-center gap-2"><input type="checkbox" checked={configuration.allowEphemeral !== false} onChange={e => onChange(allowed, { ...configuration, allowEphemeral: e.target.checked })} />Allow ephemeral browser</label>
    <label className="flex flex-wrap items-center gap-2">Default browser profile<select aria-label="Default browser profile" className="rounded border bg-background p-2" value={configuration.defaultProfileId ?? ''} onChange={e => onChange(allowed, { ...configuration, defaultProfileId: e.target.value || undefined })}><option value="">No default profile</option>{profiles.filter(p => configuration.allowedProfileIds.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <div className="flex gap-2"><Input aria-label="Create browser profile name" value={name} onChange={e => setName(e.target.value)} maxLength={100} /><Button type="button" disabled={pending || !name.trim()} onClick={() => { setPending(true); setError(''); void browserApi.createProfile(name.trim()).then(({ profile }) => { setProfiles(p => [...p, profile]); assign(profile.id, true); setName('') }).catch(e => setError(e.message)).finally(() => setPending(false)) }}>Create and assign profile</Button></div>
    <a className="text-primary underline" href={manageUrl.pathname + manageUrl.search}>Manage browser profiles</a>{error && <p role="alert" className="text-destructive">{error}</p>}
  </section>
}
