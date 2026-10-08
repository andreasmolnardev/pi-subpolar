import { useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { touchProjectActivity } from '@/api/projects'

export function useProjectActivity(projectId: number, enabled: boolean) {
  const { mutate, isPending } = useMutation({
    mutationFn: () => touchProjectActivity(projectId),
  })

  useEffect(() => {
    if (enabled && projectId > 0) mutate()
  }, [projectId, enabled, mutate])

  return { touching: isPending }
}
