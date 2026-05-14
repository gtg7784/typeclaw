import { describe, expect, test } from 'bun:test'

import { decrypt, EncryptionError, encrypt, fingerprintKey, generateKey } from './encryption'

describe('AES-256-GCM secrets encryption', () => {
  test('encrypt then decrypt returns the original plaintext', () => {
    const key = generateKey()
    const context = { containerName: 'kakao', accountId: '438346815' }
    const envelope = encrypt('hunter2', key, context)
    const recovered = decrypt(envelope, key, context)
    expect(recovered).toBe('hunter2')
  })

  test('envelope carries the expected metadata fields', () => {
    const key = generateKey()
    const envelope = encrypt('s3cret', key, { containerName: 'a', accountId: 'b' })
    expect(envelope.v).toBe(1)
    expect(envelope.alg).toBe('AES-256-GCM')
    expect(envelope.kid).toBe(fingerprintKey(key))
    expect(envelope.iv.length).toBeGreaterThan(0)
    expect(envelope.ciphertext.length).toBeGreaterThan(0)
    expect(envelope.authTag.length).toBeGreaterThan(0)
    expect(typeof envelope.createdAt).toBe('string')
  })

  test('encrypting the same plaintext twice produces different ciphertexts (random IV)', () => {
    const key = generateKey()
    const ctx = { containerName: 'kakao', accountId: 'acc-1' }
    const a = encrypt('same-plaintext', key, ctx)
    const b = encrypt('same-plaintext', key, ctx)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.authTag).not.toBe(b.authTag)
  })

  test('decrypt with the wrong key fails with decrypt_failed', () => {
    const key = generateKey()
    const wrongKey = generateKey()
    const envelope = encrypt('p', key, { containerName: 'c', accountId: 'a' })
    expect(() => decrypt(envelope, wrongKey, { containerName: 'c', accountId: 'a' })).toThrow(EncryptionError)
    try {
      decrypt(envelope, wrongKey, { containerName: 'c', accountId: 'a' })
    } catch (err) {
      expect((err as EncryptionError).code).toBe('decrypt_failed')
    }
  })

  test('decrypt with mismatched containerName AAD fails', () => {
    const key = generateKey()
    const envelope = encrypt('p', key, { containerName: 'kakao-a', accountId: '1' })
    expect(() => decrypt(envelope, key, { containerName: 'kakao-b', accountId: '1' })).toThrow(EncryptionError)
  })

  test('decrypt with mismatched accountId AAD fails', () => {
    const key = generateKey()
    const envelope = encrypt('p', key, { containerName: 'kakao', accountId: 'acc-1' })
    expect(() => decrypt(envelope, key, { containerName: 'kakao', accountId: 'acc-2' })).toThrow(EncryptionError)
  })

  test('tampered ciphertext fails authentication', () => {
    const key = generateKey()
    const ctx = { containerName: 'c', accountId: 'a' }
    const envelope = encrypt('original', key, ctx)
    const flipped = Buffer.from(envelope.ciphertext, 'base64')
    flipped[0] = flipped[0]! ^ 1
    const tampered = { ...envelope, ciphertext: flipped.toString('base64') }
    expect(() => decrypt(tampered, key, ctx)).toThrow(EncryptionError)
  })

  test('tampered authTag fails authentication', () => {
    const key = generateKey()
    const ctx = { containerName: 'c', accountId: 'a' }
    const envelope = encrypt('original', key, ctx)
    const flipped = Buffer.from(envelope.authTag, 'base64')
    flipped[0] = flipped[0]! ^ 1
    const tampered = { ...envelope, authTag: flipped.toString('base64') }
    expect(() => decrypt(tampered, key, ctx)).toThrow(EncryptionError)
  })

  test('rejects envelope with unsupported version', () => {
    const key = generateKey()
    const envelope = encrypt('p', key, { containerName: 'c', accountId: 'a' })
    const bad = { ...envelope, v: 2 as unknown as 1 }
    expect(() => decrypt(bad, key, { containerName: 'c', accountId: 'a' })).toThrow(EncryptionError)
    try {
      decrypt(bad, key, { containerName: 'c', accountId: 'a' })
    } catch (err) {
      expect((err as EncryptionError).code).toBe('envelope_invalid')
    }
  })

  test('rejects key of incorrect size', () => {
    const tinyKey = Buffer.alloc(16)
    expect(() => encrypt('p', tinyKey, { containerName: 'c', accountId: 'a' })).toThrow(EncryptionError)
  })

  test('fingerprintKey is deterministic per key and differs across keys', () => {
    const a = generateKey()
    const b = generateKey()
    expect(fingerprintKey(a)).toBe(fingerprintKey(a))
    expect(fingerprintKey(a)).not.toBe(fingerprintKey(b))
    expect(fingerprintKey(a)).toMatch(/^sha256:[0-9a-f]{16}$/)
  })
})
