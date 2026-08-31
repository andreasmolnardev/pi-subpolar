import { useQuery } from '@tanstack/react-query'
import { BarChart3, Coins, Loader2, MessageSquare, RefreshCw, Zap } from 'lucide-react'
import { piApi, type Session } from '@/pi'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type UsageStats = {
  userMessages?: number
  assistantMessages?: number
  toolCalls?: number
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
  cost?: number
}
type UsageRow = { session: Session; stats: UsageStats | null }

const number = (value: number | undefined) => (value ?? 0).toLocaleString()
const currency = (value: number | undefined) => `$${(value ?? 0).toFixed(4)}`

export function UsageSettings() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['usage-stats'],
    queryFn: piApi.usage,
  })

  const rows = (data?.sessions ?? []) as UsageRow[]
  const totals = rows.reduce((result, row) => {
    const stats = row.stats
    result.sessions += stats ? 1 : 0
    result.messages += stats?.assistantMessages ?? 0
    result.toolCalls += stats?.toolCalls ?? 0
    result.cost += stats?.cost ?? 0
    result.tokens += stats?.tokens?.total ?? ((stats?.tokens?.input ?? 0) + (stats?.tokens?.output ?? 0) + (stats?.tokens?.cacheRead ?? 0) + (stats?.tokens?.cacheWrite ?? 0))
    return result
  }, { sessions: 0, messages: 0, toolCalls: 0, cost: 0, tokens: 0 })

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Usage stats</h2>
          <p className="mt-1 text-sm text-muted-foreground">Token usage and estimated costs across your Pi sessions.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </div>

      {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading usage…</div>}
      {error && <p className="text-sm text-destructive">Unable to load usage statistics.</p>}

      {!isLoading && !error && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={Zap} label="Total tokens" value={number(totals.tokens)} />
            <SummaryCard icon={Coins} label="Estimated cost" value={currency(totals.cost)} />
            <SummaryCard icon={MessageSquare} label="Assistant messages" value={number(totals.messages)} />
            <SummaryCard icon={BarChart3} label="Tool calls" value={number(totals.toolCalls)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By session</CardTitle>
              <CardDescription>{rows.length} session{rows.length === 1 ? '' : 's'}</CardDescription>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No session usage yet.</p> : (
                <div className="divide-y divide-border">
                  {rows.map(({ session, stats }) => (
                    <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{session.title || 'Untitled session'}</p>
                        <p className="text-xs text-muted-foreground">{number(stats?.tokens?.total)} tokens · {number(stats?.assistantMessages)} messages</p>
                      </div>
                      <p className="font-mono text-sm text-muted-foreground">{currency(stats?.cost)}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function SummaryCard({ icon: Icon, label, value }: { icon: typeof Zap; label: string; value: string }) {
  return <Card><CardContent className="flex items-center gap-3 p-4"><div className="rounded-lg bg-accent p-2"><Icon className="h-5 w-5 text-primary" /></div><div><p className="text-xs text-muted-foreground">{label}</p><p className="text-lg font-semibold">{value}</p></div></CardContent></Card>
}
