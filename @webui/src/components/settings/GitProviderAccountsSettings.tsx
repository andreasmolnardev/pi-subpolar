import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Github, KeyRound, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { showToast } from '@/lib/toast'
import { gitProviderAccountsApi, type GitProviderId } from '@/api/git-provider-accounts'

export function GitProviderAccountsSettings() {
  const queryClient = useQueryClient()
  const [provider, setProvider] = useState<GitProviderId>('github')
  const [token, setToken] = useState('')
  const accountsQuery = useQuery({ queryKey: ['git-provider-accounts'], queryFn: gitProviderAccountsApi.list })
  const connectMutation = useMutation({
    mutationFn: () => gitProviderAccountsApi.connect(provider, token),
    onSuccess: async () => {
      setToken('')
      await queryClient.invalidateQueries({ queryKey: ['git-provider-accounts'] })
      showToast.success('Git account connected')
    },
    onError: () => showToast.error('Could not authenticate this Git account'),
  })
  const revokeMutation = useMutation({
    mutationFn: gitProviderAccountsApi.revoke,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['git-provider-accounts'] })
      showToast.success('Git account disconnected')
    },
    onError: () => showToast.error('Could not disconnect Git account'),
  })
  const accounts = accountsQuery.data?.accounts ?? []

  return <section className="mb-6 rounded-lg border border-border bg-card p-4" aria-labelledby="git-provider-accounts-title">
    <div className="mb-4">
      <h3 id="git-provider-accounts-title" className="flex items-center gap-2 font-semibold"><Github className="h-4 w-4" /> Git provider accounts</h3>
      <p className="mt-1 text-sm text-muted-foreground">Connect GitHub.com or Gitee.com with a personal access token. Tokens are encrypted on the server and are never shown again. Repository operations are not enabled yet.</p>
    </div>
    <form className="grid gap-3 sm:grid-cols-[150px_1fr_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); if (token.trim()) connectMutation.mutate() }}>
      <div className="space-y-2">
        <Label htmlFor="git-provider">Provider</Label>
        <select id="git-provider" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={provider} onChange={(event) => setProvider(event.target.value as GitProviderId)} disabled={connectMutation.isPending}>
          <option value="github">GitHub</option><option value="gitee">Gitee</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="git-provider-token">Personal access token</Label>
        <Input id="git-provider-token" type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste token to connect" disabled={connectMutation.isPending} />
      </div>
      <Button type="submit" disabled={!token.trim() || connectMutation.isPending}>
        {connectMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}Connect
      </Button>
    </form>
    {accountsQuery.isLoading ? <div className="py-4 text-sm text-muted-foreground">Loading connected accounts…</div> : accountsQuery.isError ? <div className="py-4 text-sm text-destructive">Connected accounts are unavailable.</div> : accounts.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No Git provider accounts connected.</p> : <ul className="mt-4 divide-y divide-border rounded-md border border-border">
      {accounts.map((account) => <li key={account.id} className="flex items-center gap-3 p-3">
        {account.avatarUrl ? <img src={account.avatarUrl} alt="" className="h-8 w-8 rounded-full" /> : <Github className="h-8 w-8 rounded-full p-1.5 text-muted-foreground" />}
        <div className="min-w-0 flex-1"><p className="truncate font-medium">{account.displayName} <span className="font-normal text-muted-foreground">@{account.username}</span></p><p className="text-xs capitalize text-muted-foreground">{account.provider} · {account.status}</p></div>
        <Button type="button" variant="ghost" size="icon" aria-label={`Disconnect ${account.username}`} title="Disconnect" disabled={revokeMutation.isPending} onClick={() => revokeMutation.mutate(account.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </li>)}
    </ul>}
  </section>
}
