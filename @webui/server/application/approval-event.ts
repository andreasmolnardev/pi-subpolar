import { redactSensitive, redactSensitiveText } from '../core/security-redaction.ts'

export type PermissionAskedInput = {
  id: string
  sessionId?: string
  toolId: string
  input: unknown
  reason: string
}

export function permissionAskedProperties(value: PermissionAskedInput): Record<string, unknown> {
  return {
    id: value.id,
    ...(value.sessionId === undefined ? {} : { sessionID: value.sessionId }),
    permission: value.toolId === 'bash' ? 'bash' : value.toolId,
    patterns: [value.toolId],
    metadata: {
      toolId: value.toolId,
      input: redactSensitive(value.input),
      reason: redactSensitiveText(value.reason),
    },
    always: [],
  }
}
