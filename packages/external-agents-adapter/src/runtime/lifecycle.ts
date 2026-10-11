import type { ExternalScope, RuntimeSessionMapping } from './contracts.ts'
export function validateScope(scope: ExternalScope): void {
  if (!scope.ownerId || !scope.sessionId || !scope.agentId || !scope.workspace.startsWith('/')) throw new Error('Canonical external runtime scope required')
}
export function validateMapping(scope: ExternalScope, installationId: string, mapping: RuntimeSessionMapping): void {
  if (mapping.ownerId !== scope.ownerId || mapping.sessionId !== scope.sessionId || mapping.workspace !== scope.workspace || mapping.installationId !== installationId || mapping.provider !== 'opencode-v2') throw new Error('External runtime mapping scope mismatch')
}
