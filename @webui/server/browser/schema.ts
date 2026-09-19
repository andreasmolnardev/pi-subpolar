import type PocketBase from 'pocketbase'

export async function ensureBrowserSessionCollections(client: PocketBase): Promise<void> {
  const manager = client.collections as unknown as { getOne: (name: string) => Promise<Record<string, unknown>>; create: (data: Record<string, unknown>) => Promise<unknown>; update: (id: string, data: Record<string, unknown>) => Promise<unknown> }
  const ensure = async (name: string, fields: Record<string, unknown>[], indexes: string[]) => {
    const existing = await manager.getOne(name).catch(() => null)
    if (!existing) { await manager.create({ name, type: 'base', fields, indexes }); return }
    const currentFields = Array.isArray(existing.fields) ? existing.fields as Record<string, unknown>[] : []
    const currentIndexes = Array.isArray(existing.indexes) ? existing.indexes as string[] : []
    const missing = fields.filter((field) => !currentFields.some((item) => item.name === field.name))
    const indexesToAdd = indexes.filter((index) => !currentIndexes.includes(index))
    if (missing.length || indexesToAdd.length) await manager.update(String(existing.id), { ...(missing.length ? { fields: [...currentFields, ...missing] } : {}), ...(indexesToAdd.length ? { indexes: [...currentIndexes, ...indexesToAdd] } : {}) })
  }
  await ensure('browser_sessions', [
    { name: 'owner_id', type: 'text', required: true }, { name: 'project_id', type: 'text' }, { name: 'session_id', type: 'text' }, { name: 'task_id', type: 'text' },
    { name: 'lifecycle', type: 'select', required: true, values: ['open', 'closed'], maxSelect: 1 }, { name: 'current_tab_id', type: 'text' }, { name: 'current_url', type: 'text' }, { name: 'tabs', type: 'json' }, { name: 'limits', type: 'json' }, { name: 'created_at', type: 'number', required: true }, { name: 'updated_at', type: 'number', required: true }, { name: 'closed_at', type: 'number' },
  ], ['CREATE INDEX idx_browser_sessions_owner ON browser_sessions (owner_id, created_at)', 'CREATE INDEX idx_browser_sessions_scope ON browser_sessions (owner_id, project_id, session_id, task_id)'])
  await ensure('browser_audit', [{ name: 'owner_id', type: 'text', required: true }, { name: 'browser_session_id', type: 'text', required: true }, { name: 'action', type: 'text', required: true }, { name: 'details', type: 'json' }, { name: 'created_at', type: 'number', required: true }], ['CREATE INDEX idx_browser_audit_owner ON browser_audit (owner_id, created_at)', 'CREATE INDEX idx_browser_audit_session ON browser_audit (browser_session_id, created_at)'])
}
