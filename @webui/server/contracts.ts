/**
 * Dependency-free wire contracts for the versioned WebUI API.
 *
 * Keep this module safe to import from tests, tooling, and alternate hosts. It
 * must not depend on Hono, PocketBase, Pi, or browser APIs.
 */

export const SUBPOLAR_API_VERSION = 'v1' as const
export const SUBPOLAR_API_CONTRACT = 'subpolar-api.v1' as const

export const CORRELATION_FIELD_NAMES = {
  request: 'requestId',
  run: 'runId',
  session: 'sessionId',
  task: 'taskId',
  tool: 'toolCallId',
  approval: 'approvalId',
} as const

export const CORRELATION_FIELDS = Object.values(CORRELATION_FIELD_NAMES)

export const EVENT_CONTRACT_METADATA = {
  id: `${SUBPOLAR_API_CONTRACT}.events`,
  version: SUBPOLAR_API_VERSION,
  envelope: 'subpolar.event',
  requiredFields: ['eventId', 'eventType', 'occurredAt'],
  correlationFields: CORRELATION_FIELDS,
} as const

/** Constants are part of the public compatibility promise, not implementation notes. */
export const COMPATIBILITY_POLICY = {
  version: SUBPOLAR_API_VERSION,
  contract: SUBPOLAR_API_CONTRACT,
  wireFormat: 'json',
  additiveChanges: 'allowed',
  breakingChanges: 'new-versioned-contract-and-route',
  unknownResponseFields: 'ignore',
  legacyRoutes: ['/api/health'],
} as const

export type ErrorDetails = Readonly<Record<string, unknown>>

export interface SubpolarError {
  code: string
  message: string
  details?: ErrorDetails
}

export interface ErrorEnvelope {
  error: SubpolarError
  requestId?: string
}

export function errorEnvelope(
  code: string,
  message: string,
  details?: ErrorDetails,
  requestId?: string,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    ...(requestId === undefined ? {} : { requestId }),
  }
}

export type CapabilityState = 'available' | 'unconfigured' | 'unknown'

export interface CapabilityDescriptor {
  id: string
  version: string
  state: CapabilityState
  routes?: readonly string[]
}

export const CAPABILITY_DESCRIPTORS: readonly CapabilityDescriptor[] = [
  { id: 'contract.discovery', version: SUBPOLAR_API_VERSION, state: 'available', routes: ['/api/v1/capabilities'] },
  { id: 'diagnostics.health', version: SUBPOLAR_API_VERSION, state: 'available', routes: ['/api/v1/health'] },
  { id: 'event.metadata', version: SUBPOLAR_API_VERSION, state: 'available' },
] as const

export interface CapabilitiesPayload {
  contract: {
    id: typeof SUBPOLAR_API_CONTRACT
    version: typeof SUBPOLAR_API_VERSION
  }
  compatibility: typeof COMPATIBILITY_POLICY
  correlation: {
    fields: typeof CORRELATION_FIELDS
  }
  events: typeof EVENT_CONTRACT_METADATA
  capabilities: readonly CapabilityDescriptor[]
  requestId: string
}

export function createCapabilitiesPayload(requestId: string): CapabilitiesPayload {
  return {
    contract: { id: SUBPOLAR_API_CONTRACT, version: SUBPOLAR_API_VERSION },
    compatibility: COMPATIBILITY_POLICY,
    correlation: { fields: CORRELATION_FIELDS },
    events: EVENT_CONTRACT_METADATA,
    capabilities: CAPABILITY_DESCRIPTORS,
    requestId,
  }
}

export type DiagnosticState = 'available' | 'degraded' | 'unavailable' | 'unconfigured' | 'unknown'

export interface DiagnosticComponent {
  state: DiagnosticState
  reason?: string
  details?: Readonly<Record<string, unknown>>
}

export const DIAGNOSTIC_COMPONENT_NAMES = [
  'bridge',
  'runtime',
  'pocketbase',
  'projectFilesystem',
  'providers',
  'browser',
  'stt',
  'tts',
] as const

export type DiagnosticComponentName = typeof DIAGNOSTIC_COMPONENT_NAMES[number]
export type DiagnosticComponents = Readonly<Record<DiagnosticComponentName, DiagnosticComponent>>
export type HealthStatus = 'healthy' | 'degraded' | 'unknown'

const CORE_DIAGNOSTIC_COMPONENTS = ['bridge', 'runtime', 'pocketbase', 'projectFilesystem', 'providers'] as const

/** Derive service health without treating optional client capabilities as failures. */
export function deriveHealthStatus(components: DiagnosticComponents): HealthStatus {
  const core = CORE_DIAGNOSTIC_COMPONENTS.map((name) => components[name].state)
  if (core.some((state) => state === 'unavailable' || state === 'degraded')) return 'degraded'
  if (core.every((state) => state === 'unknown')) return 'unknown'
  if (core.some((state) => state === 'unknown')) return 'degraded'
  return 'healthy'
}

export interface HealthPayload {
  contract: {
    id: typeof SUBPOLAR_API_CONTRACT
    version: typeof SUBPOLAR_API_VERSION
  }
  status: HealthStatus
  timestamp: string
  components: DiagnosticComponents
  requestId: string
}

export function createHealthPayload(
  components: DiagnosticComponents,
  timestamp: string,
  requestId: string,
): HealthPayload {
  return {
    contract: { id: SUBPOLAR_API_CONTRACT, version: SUBPOLAR_API_VERSION },
    status: deriveHealthStatus(components),
    timestamp,
    components,
    requestId,
  }
}

export type LegacyHealthPayload =
  | { status: 'healthy'; timestamp: string; database: 'pocketbase'; runtime: 'pi'; pi: 'healthy' }
  | { status: 'degraded'; timestamp: string; database: 'pocketbase-unavailable'; runtime: 'pi'; pi: 'healthy'; error: 'PocketBase is unavailable' }

/** Keep the pre-v1 health wire shape explicit so compatibility changes are deliberate. */
export function createLegacyHealthPayload(healthy: boolean, timestamp: string, _activeSessions?: number): LegacyHealthPayload {
  return healthy
    ? { status: 'healthy', timestamp, database: 'pocketbase', runtime: 'pi', pi: 'healthy' }
    : { status: 'degraded', timestamp, database: 'pocketbase-unavailable', runtime: 'pi', pi: 'healthy', error: 'PocketBase is unavailable' }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]))
}

/** Canonical JSON is useful for snapshots and keeps discovery output byte-stable. */
export function serializeContractPayload(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? 'null'
}
