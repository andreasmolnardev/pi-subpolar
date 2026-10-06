export type RegistryComparisonTool = {
  id: string
  description: string
  inputSchema: Record<string, unknown>
  requiresApproval: boolean
  contextMode: string
}

export type RegistryComparison = {
  mode: 'registry-dry-run'
  onlyLeft: string[]
  onlyRight: string[]
  changed: Array<{ id: string; fields: Array<Exclude<keyof RegistryComparisonTool, 'id'>> }>
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

function index(tools: readonly RegistryComparisonTool[]): Map<string, RegistryComparisonTool> {
  const result = new Map<string, RegistryComparisonTool>()
  for (const tool of tools) {
    if (!tool.id || result.has(tool.id)) throw new Error('Comparison snapshots require non-empty, unique canonical tool IDs')
    result.set(tool.id, tool)
  }
  return result
}

/** Compare already-authorized registry projections. No discovery, provider calls, or state writes. */
export function compareRegistrySnapshots(left: readonly RegistryComparisonTool[], right: readonly RegistryComparisonTool[]): RegistryComparison {
  const a = index(left)
  const b = index(right)
  const fields = ['description', 'inputSchema', 'requiresApproval', 'contextMode'] as const
  return {
    mode: 'registry-dry-run',
    onlyLeft: [...a.keys()].filter((id) => !b.has(id)).sort(),
    onlyRight: [...b.keys()].filter((id) => !a.has(id)).sort(),
    changed: [...a.keys()].filter((id) => b.has(id)).sort().flatMap((id) => {
      const changed = fields.filter((field) => stableJson(a.get(id)![field]) !== stableJson(b.get(id)![field]))
      return changed.length ? [{ id, fields: changed }] : []
    }),
  }
}
