import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { TeachToolsSettings } from '@/components/settings/TeachToolsSettings'

interface TeachToolsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TeachToolsDialog({ open, onOpenChange }: TeachToolsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-3xl overflow-y-auto">
        <DialogTitle className="sr-only">Teach Tools</DialogTitle>
        <DialogDescription className="sr-only">
          Discover, review, and register CLI, MCP, or OpenAPI tools.
        </DialogDescription>
        <TeachToolsSettings />
      </DialogContent>
    </Dialog>
  )
}
