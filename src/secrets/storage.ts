import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  type AuthStorage,
  type AuthStorageBackend,
  AuthStorage as AuthStorageImpl,
} from '@mariozechner/pi-coding-agent'
import lockfile from 'proper-lockfile'

import { migrateLegacyAuthJson } from './migrate'
import { type SecretsFile, parseSecretsFile } from './schema'

const SCHEMA_REL = './node_modules/typeclaw/secrets.schema.json'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const SYNC_LOCK_RETRIES = 10
const SYNC_LOCK_DELAY_MS = 20

const ASYNC_LOCK_OPTIONS = {
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
  stale: 30000,
} as const

// SecretsBackend implements pi-coding-agent's AuthStorageBackend contract
// while keeping TypeClaw in control of the on-disk file shape.
//
// Upstream's FileAuthStorageBackend assumes the entire file IS the
// AuthStorageData (a flat Record<string, AuthCredential>). TypeClaw needs the
// file to also carry version + channels alongside the LLM slice, so we wrap:
// every withLock cycle reads the full envelope, presents only file.llm to the
// AuthStorage instance as if it were the whole file, and merges the result
// back into the envelope on write.
//
// Locking and durability semantics mirror upstream's FileAuthStorageBackend:
// - proper-lockfile, sync version uses busy-loop retry on ELOCKED so callers
//   stay synchronous (matching upstream's API contract)
// - parent directory created with 0o700, file written with 0o600
// - empty file is created on first access so proper-lockfile has something
//   to lock against (it requires the target to exist)
//
// We additionally write atomically (temp + rename) for durability — upstream
// uses plain writeFileSync, but we own a richer envelope and a half-write
// would leave us with neither the old nor the new shape parseable.
export class SecretsBackend implements AuthStorageBackend {
  constructor(private readonly secretsPath: string) {}

  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      const innerCurrent = JSON.stringify(envelope.llm, null, 2)

      const { result, next } = fn(innerCurrent)
      if (next !== undefined) {
        const merged = mergeLlmIntoEnvelope(envelope, next)
        this.writeEnvelopeAtomic(merged)
      }
      return result
    } finally {
      release?.()
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => Promise<void>) | undefined
    let lockCompromised = false
    let lockCompromisedError: Error | undefined
    const throwIfCompromised = (): void => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error('Secrets store lock was compromised')
      }
    }
    try {
      release = await lockfile.lock(this.secretsPath, {
        ...ASYNC_LOCK_OPTIONS,
        onCompromised: (err: Error) => {
          lockCompromised = true
          lockCompromisedError = err
        },
      })
      throwIfCompromised()
      const envelope = this.readEnvelope()
      const innerCurrent = JSON.stringify(envelope.llm, null, 2)

      const { result, next } = await fn(innerCurrent)
      throwIfCompromised()
      if (next !== undefined) {
        const merged = mergeLlmIntoEnvelope(envelope, next)
        this.writeEnvelopeAtomic(merged)
      }
      throwIfCompromised()
      return result
    } finally {
      if (release) {
        try {
          await release()
        } catch {
          // Ignore unlock errors when the lock is compromised — there is
          // nothing useful we can do, and surfacing the secondary error would
          // mask the primary failure (mirrors upstream behaviour).
        }
      }
    }
  }

  private ensureParentDir(): void {
    const dir = dirname(this.secretsPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    }
  }

  // proper-lockfile requires the target to exist before locking. We seed an
  // empty new-shape envelope so the very first call has something to lock,
  // and so the file is parseable by a third-party reader even before the
  // first credential is written.
  private ensureFileExists(): void {
    if (existsSync(this.secretsPath)) return
    const seed = newEmptyEnvelope()
    writeFileSync(this.secretsPath, stringifyEnvelope(seed), 'utf8')
    chmodSync(this.secretsPath, FILE_MODE)
  }

  private acquireSyncLockWithRetry(): () => void {
    let lastError: unknown
    for (let attempt = 1; attempt <= SYNC_LOCK_RETRIES; attempt++) {
      try {
        return lockfile.lockSync(this.secretsPath, { realpath: false })
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : undefined
        if (code !== 'ELOCKED' || attempt === SYNC_LOCK_RETRIES) throw error
        lastError = error
        // Busy-wait so the call stays synchronous. Matches upstream's
        // FileAuthStorageBackend.acquireLockSyncWithRetry.
        const start = Date.now()
        while (Date.now() - start < SYNC_LOCK_DELAY_MS) {
          // intentionally empty
        }
      }
    }
    throw (lastError as Error | undefined) ?? new Error('Failed to acquire secrets store lock')
  }

  private readEnvelope(): SecretsFile {
    const raw = existsSync(this.secretsPath) ? readFileSync(this.secretsPath, 'utf8') : ''
    if (!raw.trim()) return newEmptyEnvelope()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`secrets file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    const result = parseSecretsFile(parsed)
    if (!result.ok) {
      throw new Error(`secrets file is not a valid TypeClaw secrets file: ${result.reason}`)
    }
    return result.file
  }

  // Atomic temp+rename, same pattern as src/hostd/daemon.ts:persistRegistration.
  // The temp file lives in the same directory so rename is intra-filesystem.
  private writeEnvelopeAtomic(envelope: SecretsFile): void {
    const tmp = `${this.secretsPath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, stringifyEnvelope(envelope), { encoding: 'utf8', mode: FILE_MODE })
    try {
      renameSync(tmp, this.secretsPath)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        // best-effort cleanup of the temp file when rename fails
      }
      throw err
    }
    chmodSync(this.secretsPath, FILE_MODE)
  }
}

// createSecretsStoreForAgent is the single seam every TypeClaw caller should
// use to obtain an AuthStorage tied to an agent folder's secrets file. Keeps
// the upstream constructor (AuthStorage.fromStorage) usage isolated to one
// module so a future change to upstream wiring only touches this file.
//
// Performs the one-shot auth.json -> secrets.json rename before opening the
// backend, so callers never observe the legacy filename even on agents that
// pre-date the rename.
export function createSecretsStoreForAgent(secretsPath: string): AuthStorage {
  migrateLegacyAuthJson(dirname(secretsPath))
  return AuthStorageImpl.fromStorage(new SecretsBackend(secretsPath))
}

function newEmptyEnvelope(): SecretsFile {
  return { $schema: SCHEMA_REL, version: 1, llm: {}, channels: {} }
}

function stringifyEnvelope(envelope: SecretsFile): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

function mergeLlmIntoEnvelope(envelope: SecretsFile, nextLlmJson: string): SecretsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(nextLlmJson)
  } catch (err) {
    throw new Error(
      `AuthStorage produced invalid JSON for the llm slice: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!isPlainObject(parsed)) {
    throw new Error('AuthStorage produced a non-object llm slice')
  }
  return {
    ...envelope,
    $schema: envelope.$schema ?? SCHEMA_REL,
    llm: parsed as SecretsFile['llm'],
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
