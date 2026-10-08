import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ProjectLspServerList } from './ProjectLspServerList'
import { useLSPStatus } from '@/hooks/useLSPStatus'

interface ProjectLspDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  apiUrl: string | null | undefined
  directory?: string
}

export function ProjectLspDialog({ open, onOpenChange, apiUrl, directory }: ProjectLspDialogProps) {
  const { isLoading, data } = useLSPStatus(apiUrl, directory)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] w-full">
        <DialogHeader>
          <DialogTitle>LSP Servers</DialogTitle>
        </DialogHeader>
        <ProjectLspServerList isLoading={isLoading} data={data} />
      </DialogContent>
    </Dialog>
  )
}
