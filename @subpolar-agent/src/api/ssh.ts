import { FetchError, fetchWrapper } from './fetchWrapper'
import { API_BASE_URL } from '@/config'

interface SSHHostKeyResponse {
  success: boolean
  error?: string
}

export async function respondSSHHostKey(requestId: string, approved: boolean): Promise<SSHHostKeyResponse> {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 256 || /[\x00-\x20\x7f]/.test(requestId) || typeof approved !== 'boolean') {
    throw new FetchError('Invalid SSH host-key response', undefined, 'INVALID_SSH_RESPONSE')
  }
  // There is no backend challenge/trust store or SSH transport in this deployment.
  // A UI boolean cannot prove out-of-band verification or safely authorize key rotation.
  if (approved) {
    throw new FetchError('SSH host-key approval is unavailable until a verified backend trust flow is deployed', undefined, 'SSH_TRANSPORT_UNAVAILABLE')
  }
  let result: unknown
  try {
    result = await fetchWrapper(`${API_BASE_URL}/api/ssh/host-key/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, response: 'reject' }),
    })
  } catch (error) {
    // Do not surface arbitrary backend/transport text that might contain credentials.
    throw new FetchError('SSH host-key rejection was not acknowledged', error instanceof FetchError ? error.statusCode : undefined, 'SSH_RESPONSE_FAILED')
  }
  if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true) {
    throw new FetchError('SSH host-key rejection was not acknowledged', undefined, 'SSH_RESPONSE_FAILED')
  }
  return { success: true }
}
