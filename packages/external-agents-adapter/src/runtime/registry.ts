import type { ExternalRuntimeProvider } from './contracts.ts'
export class ExternalRuntimeRegistry {
  private providers = new Map<string, ExternalRuntimeProvider>()
  register(provider: ExternalRuntimeProvider) { if (this.providers.has(provider.id)) throw new Error('Runtime already registered'); this.providers.set(provider.id,provider) }
  get(id: string) { const provider = this.providers.get(id); if (!provider) throw new Error('External runtime unavailable'); return provider }
  list() { return [...this.providers.values()].map(provider => ({id:provider.id,capabilities:provider.capabilities()})) }
  async close() { await Promise.all([...this.providers.values()].map(provider => provider.close())); this.providers.clear() }
}
