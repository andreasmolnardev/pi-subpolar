import { LoaderCircle } from "lucide-react"

import { cn } from "@/lib/utils"

export function Spinner({ className, ...props }: React.ComponentProps<typeof LoaderCircle>) {
  return <LoaderCircle role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
}
