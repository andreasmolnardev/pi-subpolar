import { describe, expect, test } from 'bun:test'
import {
  COMPATIBILITY_POLICY,
  CORRELATION_FIELDS,
  createCapabilitiesPayload,
  createHealthPayload,
  createLegacyHealthPayload,
  deriveHealthStatus,
  errorEnvelope,
  serializeContractPayload,
  SUBPOLAR_API_CONTRACT,
  SUBPOLAR_API_VERSION,
} from './contracts'

const components = {
  bridge: { state: 'available' as const },
  runtime: { state: 'available' as const },
  pocketbase: { state: 'available' as const },
  projectFilesystem: { state: 'available' as const },
  providers: { state: 'unconfigured' as const },
  browser: { state: 'unknown' as const, reason: 'client_capability_not_observed' },
  stt: { state: 'unknown' as const, reason: 'client_capability_not_observed' },
  tts: { state: 'unknown' as const, reason: 'client_capability_not_observed' },
}

describe('WebUI API contracts', () => {
  test('creates the stable error envelope without optional fields', () => {
    expect(errorEnvelope('NOT_READY', 'The service is not ready')).toEqual({
      error: { code: 'NOT_READY', message: 'The service is not ready' },
    })
    expect(errorEnvelope('INVALID', 'Invalid input', { field: 'name' }, 'req-1')).toEqual({
      error: { code: 'INVALID', message: 'Invalid input', details: { field: 'name' } },
      requestId: 'req-1',
    })
    expect(serializeContractPayload(errorEnvelope('INVALID', 'Invalid input', { field: 'name' }, 'req-1')))
      .toBe('{"error":{"code":"INVALID","details":{"field":"name"},"message":"Invalid input"},"requestId":"req-1"}')
  })

  test('serializes capability discovery deterministically', () => {
    const payload = createCapabilitiesPayload('req-1')
    expect(payload.contract).toEqual({ id: SUBPOLAR_API_CONTRACT, version: SUBPOLAR_API_VERSION })
    expect(payload.correlation.fields).toEqual(CORRELATION_FIELDS)
    expect(payload.compatibility).toEqual(COMPATIBILITY_POLICY)
    expect(serializeContractPayload(payload)).toBe(serializeContractPayload(createCapabilitiesPayload('req-1')))
    expect(serializeContractPayload(payload)).toContain('subpolar-api.v1')
    expect(serializeContractPayload({ z: 1, a: { y: 2, x: 3 } }))
      .toBe('{"a":{"x":3,"y":2},"z":1}')
  })

  test('derives diagnostics independently of HTTP routing', () => {
    expect(deriveHealthStatus(components)).toBe('healthy')
    expect(deriveHealthStatus({ ...components, pocketbase: { state: 'unavailable' } })).toBe('degraded')
    expect(deriveHealthStatus({ ...components, bridge: { state: 'unknown' }, runtime: { state: 'unknown' }, pocketbase: { state: 'unknown' }, projectFilesystem: { state: 'unknown' }, providers: { state: 'unknown' } })).toBe('unknown')

    expect(createHealthPayload(components, '2026-09-19T00:00:00.000Z', 'req-2')).toMatchObject({
      contract: { id: SUBPOLAR_API_CONTRACT, version: SUBPOLAR_API_VERSION },
      status: 'healthy',
      requestId: 'req-2',
      components: { browser: { state: 'unknown' }, stt: { state: 'unknown' }, tts: { state: 'unknown' } },
    })
  })

  test('keeps the legacy public health shape unchanged', () => {
    expect(createLegacyHealthPayload(true, '2026-09-19T00:00:00.000Z', 2)).toEqual({
      status: 'healthy', timestamp: '2026-09-19T00:00:00.000Z', database: 'pocketbase', runtime: 'pi', pi: 'healthy',
    })
    expect(createLegacyHealthPayload(false, '2026-09-19T00:00:00.000Z', 2)).toEqual({
      status: 'degraded', timestamp: '2026-09-19T00:00:00.000Z', database: 'pocketbase-unavailable', runtime: 'pi', pi: 'healthy', error: 'PocketBase is unavailable',
    })
  })
})
