import type { ExternalScope } from '../runtime/contracts.ts'
export type ExecutionAuthorization = { allowed: boolean; reason?: string }
export interface ShellPolicyPort {
  authorize(scope: ExternalScope, request: { command: string; cwd: string; environment: Readonly<Record<string, string>> }): Promise<ExecutionAuthorization>
  audit(scope: ExternalScope, event: { callId: string; state: 'started' | 'completed' | 'denied' | 'failed'; command: string; cwd: string; exitCode?: number; reason?: string }): Promise<void>
}
const forbidden = /^(?:PATH|HOME|TMPDIR|DYLD_.*|LD_.*|NODE_.*|BUN_.*|SHELL|ENV|BASH_ENV|ZDOTDIR|CDPATH|IFS|.*(?:TOKEN|SECRET|PASSWORD|API_KEY).*)$/i
export function safeEnvironment(input: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(input)
  if (entries.length > 64) throw new Error('Too many environment variables')
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || forbidden.test(key) || typeof value !== 'string' || value.includes('\0') || value.length > 8192) throw new Error('Environment variable is not permitted')
  }
  return Object.fromEntries(entries)
}
