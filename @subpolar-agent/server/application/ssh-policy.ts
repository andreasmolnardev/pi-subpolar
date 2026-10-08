import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
const fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/).refine((value) => {
  const encoded = value.slice(7)
  return Buffer.from(encoded, 'base64').toString('base64').replace(/=+$/, '') === encoded
})
const hostKeySchema = z.object({
  keyType: z.literal('ssh-ed25519'),
  fingerprint,
}).strict()
const profileSchema = z.object({
  id: identifier,
  ownerId: identifier,
  name: z.string().trim().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/),
  // No URLs, user@host, options, or shell fragments. IPv6 literals are unbracketed.
  host: z.string().min(1).max(253).refine((host) => isIP(host) !== 0 ||
      host.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))),
  port: z.number().int().min(1).max(65535),
  username: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/),
  credentialRef: identifier,
  hostKey: hostKeySchema.nullable(),
}).strict()

export type SshRemoteProfile = z.infer<typeof profileSchema>
export type SshPolicyErrorCode = 'INVALID_REMOTE_PROFILE' | 'REMOTE_PROFILE_FORBIDDEN' | 'INVALID_HOST_KEY' | 'UNKNOWN_HOST_KEY' | 'HOST_KEY_CHANGED' | 'SSH_TRANSPORT_UNAVAILABLE'

export class SshPolicyError extends Error {
  constructor(readonly code: SshPolicyErrorCode) {
    // Never include profile input, credentials, or transport exception text.
    super(code)
    this.name = 'SshPolicyError'
  }
}

/** Server-owned profile data only; this does not enroll a key or authorize execution. */
export function validateSshRemoteProfile(input: unknown, ownerId: string): SshRemoteProfile {
  const result = profileSchema.safeParse(input)
  if (!result.success) throw new SshPolicyError('INVALID_REMOTE_PROFILE')
  if (result.data.ownerId !== ownerId) throw new SshPolicyError('REMOTE_PROFILE_FORBIDDEN')
  return result.data
}

/** Allowlist serialization rather than attempting to scrub arbitrary secret fields. */
export function publicSshRemoteProfile(input: unknown, ownerId: string) {
  const profile = validateSshRemoteProfile(input, ownerId)
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    hostKey: profile.hostKey,
    hasCredential: true,
    executionAvailable: false as const,
  }
}

/** Accept only the exact Ed25519 SSH public-key wire format, never a claimed fingerprint. */
export function sshHostKeyFingerprint(publicKey: Uint8Array): string {
  const key = Buffer.from(publicKey)
  if (key.length !== 51 || key.readUInt32BE(0) !== 11 ||
      !key.subarray(4, 15).equals(Buffer.from('ssh-ed25519')) || key.readUInt32BE(15) !== 32) {
    throw new SshPolicyError('INVALID_HOST_KEY')
  }
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** A future transport must call this on the peer's actual key before sending credentials. */
export function verifySshHostKey(input: unknown, ownerId: string, publicKey: Uint8Array): void {
  const profile = validateSshRemoteProfile(input, ownerId)
  const actual = sshHostKeyFingerprint(publicKey)
  if (!profile.hostKey) throw new SshPolicyError('UNKNOWN_HOST_KEY')
  const expectedBytes = Buffer.from(profile.hostKey.fingerprint.slice(7), 'base64')
  const actualBytes = Buffer.from(actual.slice(7), 'base64')
  if (!timingSafeEqual(expectedBytes, actualBytes)) throw new SshPolicyError('HOST_KEY_CHANGED')
}

export const SSH_REMOTE_EXECUTION_AVAILABLE = false

/** Explicit capability guard, not a stub returning successful remote execution. */
export function requireSshTransport(): never {
  throw new SshPolicyError('SSH_TRANSPORT_UNAVAILABLE')
}
