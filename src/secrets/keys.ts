import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { fingerprintKey, generateKey } from './encryption'

const KEY_FILE_MODE = 0o600
const KEY_DIR_MODE = 0o700
const KEY_BYTES = 32

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export class KeyStoreError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_name' | 'missing' | 'corrupt_size',
  ) {
    super(message)
    this.name = 'KeyStoreError'
  }
}

export type KeyStoreOptions = {
  keysDir: string
}

// Per-agent symmetric key store. Each container/agent gets its own 32-byte
// random key under <keysDir>/<containerName>.key (file mode 0600, dir 0700).
// The host CLI generates and reads these; hostd reads them during scheduled
// renewal. The container never receives the key — that's load-bearing for the
// encryption-vs-collocation argument in encryption.ts's threat model comment.
export function createKeyStore(opts: KeyStoreOptions): KeyStore {
  const ensureDir = async (): Promise<void> => {
    await mkdir(opts.keysDir, { recursive: true })
    await chmod(opts.keysDir, KEY_DIR_MODE).catch(() => {})
    await chmod(dirname(opts.keysDir), KEY_DIR_MODE).catch(() => {})
  }

  const keyPath = (containerName: string): string => {
    if (!SAFE_NAME.test(containerName)) {
      throw new KeyStoreError(`invalid container name for key file: ${JSON.stringify(containerName)}`, 'invalid_name')
    }
    return join(opts.keysDir, `${containerName}.key`)
  }

  return {
    keyPath,

    exists(containerName: string): boolean {
      try {
        return existsSync(keyPath(containerName))
      } catch {
        return false
      }
    },

    async read(containerName: string): Promise<Buffer> {
      const path = keyPath(containerName)
      if (!existsSync(path)) {
        throw new KeyStoreError(`key file missing: ${path}`, 'missing')
      }
      const buf = await readFile(path)
      if (buf.length !== KEY_BYTES) {
        throw new KeyStoreError(`key file is ${buf.length} bytes (expected ${KEY_BYTES}): ${path}`, 'corrupt_size')
      }
      return buf
    },

    async ensure(containerName: string): Promise<Buffer> {
      const path = keyPath(containerName)
      if (existsSync(path)) {
        const existing = await readFile(path)
        if (existing.length === KEY_BYTES) return existing
        // Corrupt-size key: surface rather than silently overwrite. The user
        // may have a backup; replacing it here would make every existing
        // ciphertext permanently undecryptable without telling them.
        throw new KeyStoreError(
          `existing key file is ${existing.length} bytes (expected ${KEY_BYTES}): ${path}. ` +
            'Move it aside and re-run reauth to mint a fresh key.',
          'corrupt_size',
        )
      }
      await ensureDir()
      const fresh = generateKey()
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, fresh, { mode: KEY_FILE_MODE })
      await rename(tmp, path)
      await chmod(path, KEY_FILE_MODE).catch(() => {})
      return fresh
    },

    fingerprint(key: Buffer): string {
      return fingerprintKey(key)
    },
  }
}

export type KeyStore = {
  keyPath: (containerName: string) => string
  exists: (containerName: string) => boolean
  read: (containerName: string) => Promise<Buffer>
  ensure: (containerName: string) => Promise<Buffer>
  fingerprint: (key: Buffer) => string
}
