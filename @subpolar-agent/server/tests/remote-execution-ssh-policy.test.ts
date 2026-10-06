
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { publicSshRemoteProfile, requireSshTransport, SSH_REMOTE_EXECUTION_AVAILABLE, sshHostKeyFingerprint, validateSshRemoteProfile, verifySshHostKey } from '../application/ssh-policy.ts'

function wireKey(byte: number) {
  return Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, byte)])
}
const key = wireKey(1)
const pinnedFingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
const profile = {
  id: 'remote-1', ownerId: 'owner-1', name: 'Build host', host: 'build.example.com', port: 22,
  username: 'builder', credentialRef: 'vault-key-1', hostKey: { keyType: 'ssh-ed25519', fingerprint: pinnedFingerprint },
}

describe('remote execution SSH security foundation (no transport)', () => {
  it('computes a fingerprint from the actual wire key and verifies a pre-enrolled pin', () => {
    expect(sshHostKeyFingerprint(key)).toBe(pinnedFingerprint)
    expect(() => verifySshHostKey(profile, 'owner-1', key)).not.toThrow()
  })

  it('refuses unknown keys and changed keys without modifying the trusted profile', () => {
    expect(() => verifySshHostKey({ ...profile, hostKey: null }, 'owner-1', key)).toThrow('UNKNOWN_HOST_KEY')
    expect(() => verifySshHostKey(profile, 'owner-1', wireKey(2))).toThrow('HOST_KEY_CHANGED')
    expect(profile.hostKey.fingerprint).toBe(pinnedFingerprint)
  })

  it('refuses cross-owner profile access and verification', () => {
    for (const action of [validateSshRemoteProfile, publicSshRemoteProfile]) {
      expect(() => action(profile, 'other-owner')).toThrow('REMOTE_PROFILE_FORBIDDEN')
    }
    expect(() => verifySshHostKey(profile, 'other-owner', key)).toThrow('REMOTE_PROFILE_FORBIDDEN')
  })

  it.each(['user@host', '-oProxyCommand=evil', 'ssh://host', 'host;evil', 'host\nnext', 'host/path', 'bad..host', ':', 'a'.repeat(64)])('refuses malformed endpoints: %s', (host) => {
    expect(() => validateSshRemoteProfile({ ...profile, host }, 'owner-1')).toThrow('INVALID_REMOTE_PROFILE')
  })

  it.each(['build.example.com', '10.0.0.1', '::1'])('can describe an endpoint without granting network access: %s', (host) => {
    expect(validateSshRemoteProfile({ ...profile, host }, 'owner-1').host).toBe(host)
  })

  it.each([0, 65536, 22.5])('rejects invalid ports: %s', (port) => {
    expect(() => validateSshRemoteProfile({ ...profile, port }, 'owner-1')).toThrow('INVALID_REMOTE_PROFILE')
  })

  it('only serializes public fields and never exposes credential locators', () => {
    const view = publicSshRemoteProfile(profile, 'owner-1')
    expect(view).toEqual({ id: profile.id, name: profile.name, host: profile.host, port: 22, username: 'builder', hostKey: profile.hostKey, hasCredential: true, executionAvailable: false })
    expect(JSON.stringify(view)).not.toContain('vault-key-1')
    expect(view).not.toHaveProperty('ownerId')
  })

  it.each(['password', 'passphrase', 'privateKey', 'sshPrivateKey', 'token', 'credentials'])('rejects inline %s without reflecting secret values', (field) => {
    try {
      publicSshRemoteProfile({ ...profile, [field]: 'TOP-SECRET' }, 'owner-1')
      throw new Error('unexpected success')
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_REMOTE_PROFILE', message: 'INVALID_REMOTE_PROFILE' })
      expect(JSON.stringify(error)).not.toContain('TOP-SECRET')
    }
  })

  it('rejects malformed, truncated, extended, or unsupported wire keys', () => {
    const invalidLength = Buffer.from(key)
    invalidLength.writeUInt32BE(31, 15)
    const invalidAlgorithm = Buffer.from(key)
    invalidAlgorithm[4] = 0
    const nonAsciiAlgorithm = Buffer.from(key)
    nonAsciiAlgorithm[4] |= 0x80
    for (const invalid of [Buffer.alloc(0), key.subarray(0, 50), Buffer.concat([key, Buffer.alloc(1)]), invalidLength, invalidAlgorithm, nonAsciiAlgorithm, Buffer.from(pinnedFingerprint)]) {
      expect(() => verifySshHostKey(profile, 'owner-1', invalid)).toThrow('INVALID_HOST_KEY')
    }
  })

  it('rejects noncanonical pins and unsupported algorithms', () => {
    for (const hostKey of [{ keyType: 'ssh-rsa', fingerprint: pinnedFingerprint }, { keyType: 'ssh-ed25519', fingerprint: 'MD5:abcd' }, { keyType: 'ssh-ed25519', fingerprint: `SHA256:${'A'.repeat(42)}B` }]) {
      expect(() => validateSshRemoteProfile({ ...profile, hostKey }, 'owner-1')).toThrow('INVALID_REMOTE_PROFILE')
    }
  })

  it('does not pretend to execute remotely or grant permissions', () => {
    expect(SSH_REMOTE_EXECUTION_AVAILABLE).toBe(false)
    expect(() => requireSshTransport()).toThrow('SSH_TRANSPORT_UNAVAILABLE')
  })
})
