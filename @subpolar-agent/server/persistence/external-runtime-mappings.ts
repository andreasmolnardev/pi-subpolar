import type { RuntimeMappingPort, RuntimeSessionMapping } from '../../../packages/external-agents-adapter/src/runtime/contracts.ts'

export type ExternalRuntimeMappingClient = {
  collection(name: string): {
    getFullList(options?: { filter?: string }): Promise<Array<Record<string, unknown>>>
    create(data: Record<string, unknown>): Promise<Record<string, unknown>>
    update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>
  }
}

export class ExternalRuntimeMappingScopeError extends Error {
  readonly code = 'EXTERNAL_RUNTIME_MAPPING_SCOPE_DENIED'
  constructor() {
    super('External runtime session mapping is outside the authorized scope')
    this.name = 'ExternalRuntimeMappingScopeError'
  }
}

function safeId(value: string): string {
  if (!value || value.length > 256 || /[\0\r\n]/.test(value)) throw new ExternalRuntimeMappingScopeError()
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function projection(row: Record<string, unknown>, ownerId: string, sessionId: string): RuntimeSessionMapping {
  if (row.owner_id !== ownerId || row.session_id !== sessionId || row.provider !== 'opencode-v2'
    || typeof row.installation_id !== 'string' || typeof row.external_session_id !== 'string'
    || typeof row.workspace !== 'string' || !row.workspace.startsWith('/')) {
    throw new ExternalRuntimeMappingScopeError()
  }
  return {
    ownerId,
    sessionId,
    provider: 'opencode-v2',
    installationId: row.installation_id,
    externalSessionId: row.external_session_id,
    workspace: row.workspace,
  }
}

/** Owner/session keyed adapter; external IDs can never be used as a lookup key. */
export class PocketBaseExternalRuntimeMappingStore implements RuntimeMappingPort {
  constructor(private readonly client: ExternalRuntimeMappingClient, private readonly collectionName = 'external_runtime_sessions') {}

  async get(ownerId: string, sessionId: string): Promise<RuntimeSessionMapping | undefined> {
    const owner = safeId(ownerId)
    const session = safeId(sessionId)
    const rows = await this.client.collection(this.collectionName).getFullList({ filter: `owner_id = "${owner}" && session_id = "${session}"` })
    const owned = rows.filter((row) => row.owner_id === ownerId && row.session_id === sessionId)
    if (owned.length > 1) throw new ExternalRuntimeMappingScopeError()
    return owned[0] ? projection(owned[0], ownerId, sessionId) : undefined
  }

  async save(mapping: RuntimeSessionMapping): Promise<void> {
    const owner = safeId(mapping.ownerId)
    const session = safeId(mapping.sessionId)
    safeId(mapping.installationId)
    safeId(mapping.externalSessionId)
    safeId(mapping.workspace)
    const workspace = mapping.workspace
    if (mapping.provider !== 'opencode-v2' || !workspace.startsWith('/')) throw new ExternalRuntimeMappingScopeError()
    const collection = this.client.collection(this.collectionName)
    const filter = `owner_id = "${owner}" && session_id = "${session}"`
    const records = await collection.getFullList({ filter })
    const existing = records.find((row) => row.owner_id === mapping.ownerId && row.session_id === mapping.sessionId)
    const data = {
      owner_id: mapping.ownerId,
      session_id: mapping.sessionId,
      provider: mapping.provider,
      installation_id: mapping.installationId,
      external_session_id: mapping.externalSessionId,
      workspace: mapping.workspace,
      updated_at: Date.now(),
    }
    if (existing && typeof existing.id === 'string') {
      await collection.update(existing.id, data)
      return
    }
    try {
      await collection.create({ ...data, created_at: Date.now() })
    } catch (error) {
      // The unique (owner_id, session_id) index arbitrates concurrent first saves.
      const raced = await collection.getFullList({ filter }).catch(() => [])
      const owned = raced.find((row) => row.owner_id === mapping.ownerId && row.session_id === mapping.sessionId)
      if (!owned || typeof owned.id !== 'string') throw error
      await collection.update(owned.id, data)
    }
  }
}
