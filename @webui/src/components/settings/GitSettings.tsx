import { useEffect, useState } from 'react'
import { Loader2, Save, User } from 'lucide-react'
import { useSettings } from '@/hooks/useSettings'
import { showToast } from '@/lib/toast'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { GitIdentity } from '@/api/types/settings'

/** Legacy Git preferences are intentionally limited to non-secret commit identity. */
export function GitSettings() {
  const { preferences, isLoading, updateSettingsAsync, isUpdating } = useSettings()
  const [gitIdentity, setGitIdentity] = useState<GitIdentity>({ name: '', email: '' })
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    if (preferences) {
      setGitIdentity(preferences.gitIdentity || { name: '', email: '' })
      setHasChanges(false)
    }
  }, [preferences])

  const updateIdentity = (field: keyof GitIdentity, value: string) => {
    const next = { ...gitIdentity, [field]: value }
    setGitIdentity(next)
    const current = preferences?.gitIdentity || { name: '', email: '' }
    setHasChanges(current.name !== next.name || current.email !== next.email)
  }

  const save = async () => {
    setIsSaving(true)
    try {
      const result = await updateSettingsAsync({ gitIdentity })
      setHasChanges(false)
      showToast.success(result.reloadError ? 'Git identity saved (server reload pending)' : 'Git identity saved')
    } catch {
      showToast.error('Failed to save Git identity')
    } finally { setIsSaving(false) }
  }

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  return <div className="rounded-lg border border-border bg-card">
    <div className="flex items-center justify-between border-b border-border px-6 py-4">
      <div><h2 className="text-lg font-semibold">Git identity</h2><p className="text-sm text-muted-foreground">Author identity used for local commits. Provider credentials are managed separately under Integrations.</p></div>
      {hasChanges && <Button type="button" size="sm" onClick={save} disabled={isSaving || isUpdating}>{isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save Changes</Button>}
    </div>
    <div className="grid gap-4 p-6 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="git-name"><User className="mr-1 inline h-4 w-4" />Name</Label><Input id="git-name" value={gitIdentity.name} onChange={(event) => updateIdentity('name', event.target.value)} disabled={isSaving} placeholder="Your Name" /></div>
      <div className="space-y-2"><Label htmlFor="git-email">Email</Label><Input id="git-email" type="email" value={gitIdentity.email} onChange={(event) => updateIdentity('email', event.target.value)} disabled={isSaving} placeholder="you@example.com" /></div>
    </div>
  </div>
}
