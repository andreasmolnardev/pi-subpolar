import { useEffect, useState } from 'react'
import { browserApi, type ScreenshotArtifact } from '@/api/browser'
import { useAuthGeneration, useAuthOwner } from '@/stores/authIdentityStore'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
export function screenshotFromOutput(output: string, metadata?: Record<string, unknown>): ScreenshotArtifact | null {
  let value: unknown = metadata?.screenshotArtifact
  if (!value) {
    try {
      let result: unknown = JSON.parse(output)
      for (let depth = 0; depth < 4 && result && typeof result === 'object'; depth++) {
        const envelope = result as Record<string, unknown>
        if (envelope.screenshotArtifact) { value = envelope.screenshotArtifact; break }
        result = envelope.value ?? envelope.result ?? envelope.error ?? envelope.details
      }
    } catch { return null }
  }
  if (!value || typeof value !== 'object') return null
  const artifact = value as Record<string, unknown>
  return typeof artifact.status === 'string' && (typeof artifact.id === 'string' || artifact.status === 'unavailable') ? { id: typeof artifact.id === 'string' ? artifact.id : '', status: artifact.status } : null
}
export function BrowserScreenshot({ artifact }: { artifact: ScreenshotArtifact }) {
  const owner = useAuthOwner(), generation = useAuthGeneration()
  return <Preview key={JSON.stringify([owner, generation, artifact.id])} artifact={artifact} />
}
function Preview({ artifact }: { artifact: ScreenshotArtifact }) {
  const [src, setSrc] = useState(''), [error, setError] = useState(false), [attempt, setAttempt] = useState(0), [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (artifact.status !== 'captured') return
    const controller = new AbortController(); let active = true, url = ''
    setError(false)
    void browserApi.artifact(artifact.id, controller.signal).then(blob => {
      if (!active) return
      if (!/^image\/(png|jpeg|webp)$/.test(blob.type) || blob.size > 12 * 1024 * 1024) throw new Error('Invalid screenshot')
      url = URL.createObjectURL(blob); setSrc(url)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false; controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [artifact.id, artifact.status, attempt])
  if (artifact.status !== 'captured') return <p className="text-xs text-muted-foreground">Screenshot unavailable for this action.</p>
  if (error) return <div className="text-xs">Screenshot unavailable or expired. <Button size="sm" variant="outline" onClick={() => setAttempt(a => a + 1)}>Retry</Button></div>
  return <div>{src ? <button type="button" aria-label="Expand browser screenshot" onClick={() => setExpanded(true)}><img src={src} alt="Browser screenshot after tool action" className="max-h-64 rounded border object-contain" /></button> : <p role="status">Loading screenshot…</p>}<Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="max-w-5xl"><DialogTitle>Browser screenshot</DialogTitle>{src && <img src={src} alt="Historical browser screenshot" className="max-h-[80vh] w-full object-contain" />}</DialogContent></Dialog></div>
}
