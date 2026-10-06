import { FetchError } from '@/api/fetchWrapper'

export const control = 'rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
export const input = 'w-full rounded-md border border-border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
export function errorMessage(error: unknown): string {
  if (error instanceof FetchError && error.code === 'CONTENT_CONFLICT') return 'File changed on disk. Your draft is safe. Copy it before reloading, or reload to discard it and read the latest version.'
  return (error instanceof Error ? error.message : 'Workspace request failed. Please retry.').slice(0, 400)
}
export function WorkspaceError({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null
  return <div role="alert" className="my-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm break-words">
    {errorMessage(error)} {retry && <button className={control} onClick={retry}>Retry</button>}
  </div>
}
