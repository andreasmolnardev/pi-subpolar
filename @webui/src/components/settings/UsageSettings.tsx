import { useQuery } from '@tanstack/react-query'
import { BarChart3, Database, Loader2, RefreshCw, Upload } from 'lucide-react'
import { getDailyUsage } from '@/api/usage'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const number = (value: number) => Math.round(value).toLocaleString()

export function UsageSettings() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['usage-daily'],
    queryFn: getDailyUsage,
  })
  const days = data?.days ?? []
  const totals = days.reduce((result, day) => ({
    input: result.input + day.input,
    output: result.output + day.output,
    cacheRead: result.cacheRead + day.cacheRead,
  }), { input: 0, output: 0, cacheRead: 0 })

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Usage</h2>
          <p className="mt-1 text-sm text-muted-foreground">Token usage grouped by day across all Pi sessions.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </div>

      {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading usage…</div>}
      {error && <p className="text-sm text-destructive">Unable to load usage statistics.</p>}

      {!isLoading && !error && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard icon={Upload} label="Input" value={number(totals.input)} />
            <SummaryCard icon={BarChart3} label="Output" value={number(totals.output)} />
            <SummaryCard icon={Database} label="Cache read" value={number(totals.cacheRead)} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Daily usage</CardTitle>
              <CardDescription>Input and output tokens, plus tokens read from provider cache.</CardDescription>
            </CardHeader>
            <CardContent>
              {days.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No usage recorded yet.</p> : (
                <div className="divide-y divide-border">
                  {days.map((day) => (
                    <div key={day.date} className="grid grid-cols-4 gap-3 py-3 text-sm first:pt-0 last:pb-0">
                      <span className="font-medium">{day.date}</span>
                      <span className="text-right"><span className="text-muted-foreground">in </span>{number(day.input)}</span>
                      <span className="text-right"><span className="text-muted-foreground">out </span>{number(day.output)}</span>
                      <span className="text-right"><span className="text-muted-foreground">cache </span>{number(day.cacheRead)}</span>
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

function SummaryCard({ icon: Icon, label, value }: { icon: typeof Upload; label: string; value: string }) {
  return <Card><CardContent className="flex items-center gap-3 p-4"><div className="rounded-lg bg-accent p-2"><Icon className="h-5 w-5 text-primary" /></div><div><p className="text-xs text-muted-foreground">{label}</p><p className="text-lg font-semibold">{value}</p></div></CardContent></Card>
}
