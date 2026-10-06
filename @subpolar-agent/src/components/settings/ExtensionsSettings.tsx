import { useQuery } from '@tanstack/react-query'
import { Code2, Loader2, Puzzle } from 'lucide-react'
import { settingsApi } from '@/api/settings'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function ExtensionsSettings() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['installed-extensions'],
    queryFn: settingsApi.listExtensions,
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Extensions</h2>
        <p className="text-sm text-muted-foreground mt-1">Extensions installed for Pi and this workspace.</p>
      </div>
      {isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      {error && <p className="text-sm text-destructive">Unable to load installed extensions.</p>}
      {!isLoading && !error && (data?.extensions.length ?? 0) === 0 && (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No extensions installed.</CardContent></Card>
      )}
      <div className="grid gap-3">
        {data?.extensions.map((extension) => (
          <Card key={`${extension.source}:${extension.path}`}>
            <CardHeader className="p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-accent p-2"><Puzzle className="h-5 w-5 text-primary" /></div>
                <div className="min-w-0">
                  <CardTitle className="text-sm">{extension.name}</CardTitle>
                  <CardDescription className="flex items-center gap-1 text-xs"><Code2 className="h-3 w-3" />{extension.source}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0"><code className="break-all text-xs text-muted-foreground">{extension.path}</code></CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
