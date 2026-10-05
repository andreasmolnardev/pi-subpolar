import { getAuthOwner, onIdentityCleanup } from '@/stores/authIdentityStore'

export type OpenFile = { path: string; content: string; expectedContent: string }
export const workspaceDrafts = new Map<string, OpenFile[]>()
export const workspaceDraftKey = (sessionId: string) => JSON.stringify([getAuthOwner(), sessionId])
export const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  if (workspaceDrafts.size) { event.preventDefault(); event.returnValue = '' }
}
onIdentityCleanup(() => {
  workspaceDrafts.clear()
  if (typeof window !== 'undefined') window.removeEventListener('beforeunload', warnBeforeUnload)
})
