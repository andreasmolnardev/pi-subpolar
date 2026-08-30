import { useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { touchProjectActivity } from '@/api/projects'

export function useProjectActivity(projectId: number, enabled: boolean) {
  const mutation = useMutation({
    mutationFn: () => touchProjectActivity(projectId),
  })

  useEffect(() => {
    if (enabled && projectId > 0) {
      mutation.mutate()
    }
  }, [projectId, enabled, mutation])

  return { touching: mutation.isPending }
}
