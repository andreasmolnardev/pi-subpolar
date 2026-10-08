import { randomUUID } from 'node:crypto'

export const DEFAULT_MAX_JSON_BODY_BYTES = 1 * 1024 * 1024

export type RequestSecurityCode = 'BODY_TOO_LARGE' | 'INVALID_JSON' | 'ORIGIN_NOT_ALLOWED' | 'RATE_LIMITED'

export class RequestSecurityError extends Error {
  readonly status: number

  constructor(readonly code: RequestSecurityCode, message: string, status = code === 'RATE_LIMITED' ? 429 : code === 'BODY_TOO_LARGE' ? 413 : 403) {
    super(message)
    this.name = 'RequestSecurityError'
    this.status = status
  }
}

export function requestId(request: Request): string {
  const supplied = request.headers.get('x-request-id')?.trim()
  return supplied && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID()
}

export async function readBoundedBody(request: Request, maxBytes = DEFAULT_MAX_JSON_BODY_BYTES): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive integer')
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestSecurityError('BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`)
  }
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) throw new RequestSecurityError('BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`)
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(result)
}

export async function readJsonBody<T extends Record<string, unknown> = Record<string, unknown>>(request: Request, maxBytes = DEFAULT_MAX_JSON_BODY_BYTES): Promise<T> {
  const text = await readBoundedBody(request, maxBytes)
  if (!text.trim()) return {} as T
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
    return value as T
  } catch {
    throw new RequestSecurityError('INVALID_JSON', 'Request body must be a JSON object', 400)
  }
}

export type OriginPolicy = {
  allowedOrigins?: readonly string[]
  allowLoopbackDev?: boolean
}

function loopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1')
  } catch {
    return false
  }
}

export function isAllowedOrigin(request: Request, policy: OriginPolicy = {}): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return request.headers.get('sec-fetch-site') !== 'cross-site'
  const allowed = new Set(policy.allowedOrigins ?? [])
  const requestOrigin = new URL(request.url).origin
  if (origin === requestOrigin || allowed.has(origin)) return true
  // Vite and the bridge commonly use different loopback host spellings.
  return policy.allowLoopbackDev === true && loopbackOrigin(origin) && loopbackOrigin(requestOrigin)
}

export function assertSafeBrowserMutation(request: Request, policy: OriginPolicy = {}): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) return
  if (!request.headers.get('origin') && request.headers.get('cookie') && request.headers.get('sec-fetch-site') !== 'same-origin') {
    throw new RequestSecurityError('ORIGIN_NOT_ALLOWED', 'Cookie-authenticated mutations require a same-origin signal')
  }
  if (!isAllowedOrigin(request, policy)) throw new RequestSecurityError('ORIGIN_NOT_ALLOWED', 'Cross-origin browser mutations are not allowed')
}

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterMs: number }

export function rateLimitKey(bucket: string, pathname: string, userId?: string): string {
  return userId?.trim() ? `${bucket}:user:${userId}` : `${bucket}:route:${pathname}`
}

type Bucket = { startedAt: number; count: number }

export class InProcessRateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, limit: number, windowMs: number): RateLimitResult {
    if (!key.trim() || !Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowMs) || windowMs <= 0) {
      throw new RangeError('Rate limit key, limit, and windowMs are required')
    }
    const now = this.now()
    const current = this.buckets.get(key)
    const bucket = !current || now - current.startedAt >= windowMs
      ? { startedAt: now, count: 0 }
      : current
    bucket.count += 1
    this.buckets.set(key, bucket)
    if (this.buckets.size > 10_000) {
      for (const [candidate, value] of this.buckets) if (now - value.startedAt >= windowMs) this.buckets.delete(candidate)
    }
    const allowed = bucket.count <= limit
    return { allowed, remaining: Math.max(0, limit - bucket.count), retryAfterMs: allowed ? 0 : Math.max(1, windowMs - (now - bucket.startedAt)) }
  }
}

export const REQUEST_LIMITS = {
  auth: { limit: 10, windowMs: 60_000 },
  mutation: { limit: 120, windowMs: 60_000 },
  read: { limit: 300, windowMs: 60_000 },
} as const
