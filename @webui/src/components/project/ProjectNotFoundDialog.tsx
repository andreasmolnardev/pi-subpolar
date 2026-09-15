import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function ProjectNotFoundDialog({ projectId }: { projectId?: string }) {
  const navigate = useNavigate()

  return (
    <Dialog open onOpenChange={(open) => { if (!open) navigate('/projects', { replace: true }) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Project not found</DialogTitle>
          <DialogDescription>
            {projectId ? `Project ${projectId} is no longer available or has not been configured in this WebUI.` : 'This project is no longer available or has not been configured in this WebUI.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => navigate('/projects', { replace: true })}>Back to projects</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
