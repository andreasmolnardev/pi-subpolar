import type { ProviderRuntime } from './provider-runtime.ts'

/** A proxy bearer token authorizes only its persisted owner, never the host catalog. */
export async function authenticateProxyRuntime(secret: string, dependencies: {
  authenticate: (secret: string) => Promise<{ ownerId: string } | null>
  runtimeForOwner: (ownerId: string) => Promise<ProviderRuntime>
}): Promise<ProviderRuntime | undefined> {
  const principal = await dependencies.authenticate(secret)
  if (!principal?.ownerId?.trim()) return undefined
  return dependencies.runtimeForOwner(principal.ownerId)
}

/** Require a qualified owned provider/model; no implicit first-model fallback. */
export function proxyModel(runtime: ProviderRuntime, selection: { providerID: string; modelID: string } | undefined) {
  return selection ? runtime.getModel(selection.providerID, selection.modelID) : undefined
}
