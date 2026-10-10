import type { JsonValue, RuntimeExecution, StatelessExecutor } from '../../../subpolar-contracts/src/index.ts'

/** Values are resolved and authorized by Subpolar, never by external tool input. */
export interface ExternalScope {
  ownerId: string
  sessionId: string
  agentId: string
  projectId?: string
  workspace: string
  parentSessionId?: string
  allowedToolIds?: readonly string[]
}
export interface ExternalTool {
  id: string
  description: string
  inputSchema: Record<string, unknown>
}
export interface ExternalToolBridge {
  list(scope: ExternalScope): Promise<readonly ExternalTool[]>
  call(scope: ExternalScope, toolId: string, input: JsonValue, callId: string, signal?: AbortSignal): Promise<unknown>
}
export interface IsolatedProcess {
  stdin: { write(data: string): void; end(): void }
  stdout: AsyncIterable<Uint8Array>
  stderr: AsyncIterable<Uint8Array>
  exited: Promise<number>
  stop(): Promise<void>
}
export interface IsolatedProcessRequest {
  executable: string
  args: readonly string[]
  cwd: string
  environment: Readonly<Record<string, string>>
  readableRoots: readonly string[]
  writableRoots: readonly string[]
  /** Executable allowlist for the OS boundary; default is the entry executable only. */
  allowedExecutables?: readonly string[]
  timeoutMs?: number
  maxOutputBytes?: number
  networkPorts?: readonly number[]
  signal?: AbortSignal
}
/** A trusted server-provided isolation implementation. No unsandboxed default. */
export interface IsolatedExecutionPort {
  readonly kind: string
  readonly interactive: boolean
  spawn(request: IsolatedProcessRequest): Promise<IsolatedProcess>
}
export interface RuntimeSessionMapping {
  ownerId: string
  sessionId: string
  provider: 'opencode-v2'
  installationId: string
  externalSessionId: string
  workspace: string
}
export interface RuntimeMappingPort {
  get(ownerId: string, sessionId: string): Promise<RuntimeSessionMapping | undefined>
  save(mapping: RuntimeSessionMapping): Promise<void>
}
export interface ExternalRuntimeProvider {
  readonly id: 'opencode-v2'
  readonly execute: StatelessExecutor
  capabilities(): Record<string, boolean | string | number>
  close(): Promise<void>
}
export type ExternalRuntimeExecution = RuntimeExecution
