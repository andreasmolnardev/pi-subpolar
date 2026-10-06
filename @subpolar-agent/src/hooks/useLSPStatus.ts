import { useQuery } from '@tanstack/react-query'
import { useSubpolarClient } from './usePiHarness'

export function useLSPStatus(apiUrl: string | null | undefined, directory?: string) {
  const client = useSubpolarClient(apiUrl, directory)

  return useQuery({
    queryKey: ['subpolar', 'lsp', apiUrl, directory],
    queryFn: () => client!.getLSPStatus(),
    enabled: !!client,
    refetchInterval: 30000,
    staleTime: 10000,
    refetchOnWindowFocus: true,
  })
}
