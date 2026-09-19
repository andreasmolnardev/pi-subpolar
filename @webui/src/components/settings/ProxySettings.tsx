import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react'
import { generateProxyCredential, listProxyCredentials, proxyBaseUrl, revokeProxyCredential } from '@/api/proxy'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function ProxySettings() {
  const queryClient = useQueryClient()
  const [newSecret, setNewSecret] = useState<string>()
  const credentials = useQuery({ queryKey: ['proxy-credentials'], queryFn: listProxyCredentials })
  const generate = useMutation({
    mutationFn: generateProxyCredential,
    onSuccess: (result) => {
      setNewSecret(result.secret)
      void queryClient.invalidateQueries({ queryKey: ['proxy-credentials'] })
    },
  })
  const revoke = useMutation({
    mutationFn: revokeProxyCredential,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['proxy-credentials'] }),
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Proxy</h2>
        <p className="mt-1 text-sm text-muted-foreground">Use the selected Pi model through a local OpenAI-compatible endpoint.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Endpoint</CardTitle>
          <CardDescription>{proxyBaseUrl()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200">
            The proxy intentionally removes <code>system</code> and <code>developer</code> messages before sending a request upstream. Pi&apos;s harness prompt is never exposed to proxy clients.
          </p>
          <p className="text-muted-foreground">Send a standard <code>POST /chat/completions</code> request with a bearer token and a model such as <code>provider/model</code>.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Credentials</CardTitle>
            <CardDescription>Credentials are local to this WebUI and are only shown once when generated.</CardDescription>
          </div>
          <Button size="sm" onClick={() => generate.mutate()} disabled={generate.isPending}>
            {generate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Generate
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {newSecret && (
            <div className="rounded-md border border-primary/40 bg-primary/10 p-3">
              <p className="mb-2 text-sm font-medium">Copy this credential now</p>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-background p-2 text-xs">{newSecret}</code>
                <Button variant="outline" size="icon" onClick={() => void navigator.clipboard?.writeText(newSecret)} aria-label="Copy credential"><Copy className="h-4 w-4" /></Button>
              </div>
            </div>
          )}
          {credentials.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading credentials…</div>}
          {!credentials.isLoading && (credentials.data?.credentials.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">No proxy credentials generated.</p>}
          {credentials.data?.credentials.map((credential) => (
            <div key={credential.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="flex min-w-0 items-center gap-2"><KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" /><code className="truncate text-sm">{credential.prefix}…</code><span className="text-xs text-muted-foreground">{new Date(credential.createdAt).toLocaleString()}</span></div>
              <Button variant="ghost" size="icon" onClick={() => revoke.mutate(credential.id)} aria-label="Revoke credential"><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
