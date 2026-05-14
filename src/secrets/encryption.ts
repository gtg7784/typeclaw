import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// AES-256-GCM authenticated encryption for at-rest secrets. The threat model
// is "agent folder leaked but ~/.typeclaw/keys/ did not" — backups, accidental
// copies, mistakes like `git add secrets.json`. This is defense-in-depth for
// at-rest folder leaks, not a sandbox boundary; anyone with read access to
// both the agent folder and ~/.typeclaw/ already has the live OAuth tokens
// stored next to the encrypted blob, so they bypass encryption entirely.
//
// AAD binds the ciphertext to the specific (containerName, accountId, version)
// it was produced for, so a ciphertext copied between accounts or containers
// fails authentication on decrypt even if the same key happens to unlock both.

const ALGORITHM = 'AES-256-GCM' as const
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const ENVELOPE_VERSION = 1

export type EncryptedEnvelope = {
  v: typeof ENVELOPE_VERSION
  alg: typeof ALGORITHM
  kid: string
  iv: string
  ciphertext: string
  authTag: string
  createdAt: string
}

export type EncryptionContext = {
  containerName: string
  accountId: string
}

export class EncryptionError extends Error {
  constructor(
    message: string,
    public readonly code: 'decrypt_failed' | 'envelope_invalid' | 'key_size_invalid' | 'algorithm_unsupported',
  ) {
    super(message)
    this.name = 'EncryptionError'
  }
}

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function fingerprintKey(key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new EncryptionError(`key must be ${KEY_BYTES} bytes, got ${key.length}`, 'key_size_invalid')
  }
  return `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

export function encrypt(plaintext: string, key: Buffer, context: EncryptionContext): EncryptedEnvelope {
  if (key.length !== KEY_BYTES) {
    throw new EncryptionError(`key must be ${KEY_BYTES} bytes, got ${key.length}`, 'key_size_invalid')
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(buildAad(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    kid: fingerprintKey(key),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
    createdAt: new Date().toISOString(),
  }
}

export function decrypt(envelope: EncryptedEnvelope, key: Buffer, context: EncryptionContext): string {
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new EncryptionError(`unsupported envelope version: ${envelope.v}`, 'envelope_invalid')
  }
  if (envelope.alg !== ALGORITHM) {
    throw new EncryptionError(`unsupported algorithm: ${envelope.alg}`, 'algorithm_unsupported')
  }
  if (key.length !== KEY_BYTES) {
    throw new EncryptionError(`key must be ${KEY_BYTES} bytes, got ${key.length}`, 'key_size_invalid')
  }
  const iv = Buffer.from(envelope.iv, 'base64')
  if (iv.length !== IV_BYTES) {
    throw new EncryptionError(`iv must be ${IV_BYTES} bytes, got ${iv.length}`, 'envelope_invalid')
  }
  const authTag = Buffer.from(envelope.authTag, 'base64')
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new EncryptionError(`authTag must be ${AUTH_TAG_BYTES} bytes, got ${authTag.length}`, 'envelope_invalid')
  }
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(buildAad(context))
  decipher.setAuthTag(authTag)
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch (err) {
    // GCM auth failure produces an opaque "Unsupported state or unable to
    // authenticate data" — wrap it so callers can distinguish a wrong key /
    // tampered blob from invariant violations on the envelope shape.
    throw new EncryptionError(`decrypt failed: ${err instanceof Error ? err.message : String(err)}`, 'decrypt_failed')
  }
}

// AAD = "typeclaw:kakaotalk-password:v1:<containerName>:<accountId>" — binds
// the ciphertext to a specific (container, account) pair. A blob copied to a
// different account or container fails authentication on decrypt even with
// the same key, so attackers can't shuffle ciphertexts between identities to
// confuse the renewal cron.
function buildAad(context: EncryptionContext): Buffer {
  return Buffer.from(`typeclaw:kakaotalk-password:v1:${context.containerName}:${context.accountId}`, 'utf8')
}
