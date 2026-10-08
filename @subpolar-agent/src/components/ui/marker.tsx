import * as React from 'react'
import { cn } from '@/lib/utils'

export function Marker({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)} {...props} />
}

export function MarkerIcon({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('flex size-4 shrink-0 items-center justify-center', className)} {...props} />
}

export function MarkerContent({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('min-w-0 truncate', className)} {...props} />
}
