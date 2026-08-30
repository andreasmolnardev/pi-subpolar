export function ProjectCardSkeleton() {
  return (
    <div className="relative border rounded-xl overflow-hidden border-border bg-card w-full">
      <div className="p-4">
        <div className="flex items-start gap-3 mb-3">
          <div className="h-5 bg-muted animate-pulse rounded w-1/3" />
        </div>
        <div className="space-y-2">
          <div className="h-4 bg-muted animate-pulse rounded w-2/3" />
          <div className="h-4 bg-muted animate-pulse rounded w-1/4" />
        </div>
      </div>
    </div>
  )
}
