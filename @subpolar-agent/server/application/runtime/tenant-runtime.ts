/** Tuple encoding avoids delimiter collisions even for service-supplied ids. */
export function tenantSessionKey(ownerId: string, sessionId: string): string {
  if (!ownerId.trim() || !sessionId.trim()) throw new Error('Session owner and id are required')
  return JSON.stringify([ownerId, sessionId])
}

export function assertTenantSession(ownerId: string, sessionId: string, record: { userId?: string; id: string }): void {
  tenantSessionKey(ownerId, sessionId)
  if (record.userId !== ownerId || record.id !== sessionId) throw new Error('Session owner or id mismatch')
}
