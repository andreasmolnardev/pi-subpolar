import { assertAuthGeneration, getAuthGeneration, onIdentityCleanup } from '@/stores/authIdentityStore'

export class FetchError extends Error {
  readonly statusCode?: number
  readonly code?: string
  readonly detail?: string
  readonly data?: Record<string, unknown>

  constructor(
    message: string,
    statusCode?: number,
    code?: string,
    detail?: string,
    data?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'FetchError'
    this.statusCode = statusCode
    this.code = code
    this.detail = detail
    this.data = data
  }
}

interface ApiErrorResponse {
  error?: string
  message?: string
  detail?: string
  details?: unknown
  code?: string
  validationIssues?: unknown
  removedFields?: unknown
}

interface FetchWrapperOptions extends RequestInit {
  timeout?: number
  params?: Record<string, string | number | boolean | null | undefined>
}

function formatDetails(details: unknown): string | undefined {
  if (Array.isArray(details)) {
    return details
      .map((d) => {
        if (typeof d !== 'object' || d === null) return null
        const path = Array.isArray((d as Record<string, unknown>).path) 
          ? ((d as Record<string, unknown>).path as string[]) 
          : undefined
        const message = typeof (d as Record<string, unknown>).message === 'string'
          ? (d as Record<string, unknown>).message as string
          : undefined
        return path?.length ? `${path.join('.')}: ${message}` : message
      })
      .filter(Boolean)
      .join('; ')
  }
  if (typeof details === 'string') return details
  return undefined
}

async function handleResponse(response: Response): Promise<never> {
  const text = await response.text().catch(() => '')
  const data: ApiErrorResponse = (() => {
    if (!text) return { error: 'An error occurred' }
    try {
      return JSON.parse(text) as ApiErrorResponse
    } catch {
      return { error: text }
    }
  })()
  const errorData = data as ApiErrorResponse & { message?: string; data?: { message?: unknown } }
  const openCodeMessage = typeof errorData.data?.message === 'string'
    ? errorData.data.message
    : undefined
  const detail = data.detail || formatDetails(data.details)
  throw new FetchError(
    data.error || errorData.message || openCodeMessage || 'Request failed',
    response.status,
    data.code,
    detail,
    {
      details: data.details,
      validationIssues: data.validationIssues,
      removedFields: data.removedFields,
    }
  )
}

function buildUrl(url: string, params?: Record<string, string | number | boolean | null | undefined>): URL {
  const urlObj = new URL(url, globalThis.location?.origin ?? 'http://localhost')
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        urlObj.searchParams.append(key, String(value))
      }
    })
  }
  return urlObj
}

async function fetchWithTimeout(
  url: string,
  options: FetchWrapperOptions = {}
): Promise<Response> {
  const { timeout = 30000, params, ...fetchOptions } = options
  const urlObj = buildUrl(url, params)

  const generation = getAuthGeneration()
  const controller = new AbortController()
  const stopCleanup = onIdentityCleanup(() => controller.abort())
  const timeoutId = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null
  const onAbort = () => controller.abort()
  if (fetchOptions.signal?.aborted) controller.abort()
  fetchOptions.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(urlObj.toString(), {
      credentials: 'include',
      ...fetchOptions,
      cache: 'no-store',
      signal: controller.signal,
    })

    if (timeoutId) clearTimeout(timeoutId)
    fetchOptions.signal?.removeEventListener('abort', onAbort)

    assertAuthGeneration(generation)
    if (!response.ok) {
      await handleResponse(response)
    }

    return response
  } catch (error) {
    assertAuthGeneration(generation)
    if (timeoutId) clearTimeout(timeoutId)
    fetchOptions.signal?.removeEventListener('abort', onAbort)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FetchError('Request timeout', 408, 'TIMEOUT')
    }
    throw error
  } finally {
    stopCleanup()
    if (timeoutId) clearTimeout(timeoutId)
    fetchOptions.signal?.removeEventListener('abort', onAbort)
  }
}

async function fetchWrapper<T = unknown>(
  url: string,
  options: FetchWrapperOptions = {}
): Promise<T> {
  const generation = getAuthGeneration()
  const response = await fetchWithTimeout(url, options)
  let data: T
  try {
    data = await response.json()
  } catch {
    assertAuthGeneration(generation)
    throw new FetchError('Invalid JSON response', response.status, 'INVALID_JSON')
  }
  assertAuthGeneration(generation)
  return data
}

async function fetchWrapperVoid(
  url: string,
  options: FetchWrapperOptions = {}
): Promise<void> {
  const generation = getAuthGeneration()
  await fetchWithTimeout(url, options)
  assertAuthGeneration(generation)
}

async function fetchWrapperBlob(
  url: string,
  options: FetchWrapperOptions = {}
): Promise<Blob> {
  const generation = getAuthGeneration()
  const response = await fetchWithTimeout(url, options)
  const blob = await response.blob()
  assertAuthGeneration(generation)
  return blob
}

export async function fetchForSubpolarClient(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(String(input), init)
}

export { fetchWrapper, fetchWrapperVoid, fetchWrapperBlob }
