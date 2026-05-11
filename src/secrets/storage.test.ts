import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuthStorage } from '@mariozechner/pi-coding-agent'

import { parseSecretsFile } from './schema'
import { createSecretsStoreForAgent, SecretsBackend } from './storage'

describe('SecretsBackend', () => {
  let dir: string
  let secretsPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-secrets-store-'))
    secretsPath = join(dir, 'secrets.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('first write produces the new envelope shape', async () => {
    const store = createSecretsStoreForAgent(secretsPath)
    store.set('openai', { type: 'api_key', key: 'sk-test' })

    const raw = await readFile(secretsPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['version']).toBe(1)
    expect(parsed['llm']).toEqual({ openai: { type: 'api_key', key: 'sk-test' } })
    expect(parsed['channels']).toEqual({})
    expect(parsed['$schema']).toBe('./node_modules/typeclaw/secrets.schema.json')
  })

  test('legacy flat file is read transparently and upgraded on next write', async () => {
    await writeFile(secretsPath, JSON.stringify({ openai: { type: 'api_key', key: 'sk-old' } }))

    const store = createSecretsStoreForAgent(secretsPath)
    expect(store.get('openai')).toEqual({ type: 'api_key', key: 'sk-old' })

    store.set('fireworks', { type: 'api_key', key: 'fw-new' })

    const raw = await readFile(secretsPath, 'utf8')
    const result = parseSecretsFile(JSON.parse(raw))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(1)
    expect(result.file.llm).toEqual({
      openai: { type: 'api_key', key: 'sk-old' },
      fireworks: { type: 'api_key', key: 'fw-new' },
    })
    expect(result.file.channels).toEqual({})
  })

  test('round-trip: set + reload + get returns the same value', () => {
    const a = createSecretsStoreForAgent(secretsPath)
    a.set('openai', { type: 'api_key', key: 'sk-roundtrip' })

    const b = createSecretsStoreForAgent(secretsPath)
    expect(b.get('openai')).toEqual({ type: 'api_key', key: 'sk-roundtrip' })

    b.set('openai', { type: 'api_key', key: 'sk-updated' })

    const c = AuthStorage.fromStorage(new SecretsBackend(secretsPath))
    expect(c.get('openai')).toEqual({ type: 'api_key', key: 'sk-updated' })
  })

  test('preserves channels and unknown top-level keys across writes', async () => {
    await writeFile(
      secretsPath,
      JSON.stringify({
        version: 1,
        llm: { openai: { type: 'api_key', key: 'sk-existing' } },
        channels: { someFutureChannel: { token: 'abc' } },
      }),
    )

    const store = createSecretsStoreForAgent(secretsPath)
    store.set('fireworks', { type: 'api_key', key: 'fw-added' })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as { version: number; llm: Record<string, unknown>; channels: Record<string, unknown> }
    expect(obj.version).toBe(1)
    expect(obj.llm['openai']).toEqual({ type: 'api_key', key: 'sk-existing' })
    expect(obj.llm['fireworks']).toEqual({ type: 'api_key', key: 'fw-added' })
    expect(obj.channels['someFutureChannel']).toEqual({ token: 'abc' })
  })

  test('file mode is 0o600 after first write', async () => {
    const store = createSecretsStoreForAgent(secretsPath)
    store.set('openai', { type: 'api_key', key: 'sk-test' })

    const stats = await stat(secretsPath)
    // Mask out the file-type bits and assert just the permission bits.
    const perms = stats.mode & 0o777
    expect(perms).toBe(0o600)
  })

  test('seed file is parseable as new envelope before any credential is written', async () => {
    // Constructing the secrets store triggers reload(), which calls withLock,
    // which seeds the file. We do not write anything else.
    createSecretsStoreForAgent(secretsPath)

    const raw = await readFile(secretsPath, 'utf8')
    const result = parseSecretsFile(JSON.parse(raw))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(1)
    expect(result.file.llm).toEqual({})
    expect(result.file.channels).toEqual({})
  })

  test('surfaces a parse error via drainErrors when the file is neither new envelope nor legacy', async () => {
    // pi-coding-agent's AuthStorage.reload() swallows backend errors into a
    // loadError + errors[] list rather than throwing, so the user-observable
    // symptom is via drainErrors(). Asserting on that contract instead of on
    // a thrown construction so the test matches reality.
    await writeFile(secretsPath, JSON.stringify({ random: 'garbage', notACredential: 42 }))

    const store = createSecretsStoreForAgent(secretsPath)
    const errors = store.drainErrors()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toMatch(/secrets file is not a valid TypeClaw secrets file/)
  })

  test('surfaces a parse error via drainErrors when the file is not valid JSON', async () => {
    await writeFile(secretsPath, '{ not json')

    const store = createSecretsStoreForAgent(secretsPath)
    const errors = store.drainErrors()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toMatch(/secrets file is not valid JSON/)
  })

  test('two store instances writing concurrently both land their changes', async () => {
    const a = createSecretsStoreForAgent(secretsPath)
    const b = createSecretsStoreForAgent(secretsPath)

    // The withLock contract serialises sync writes through proper-lockfile,
    // so interleaved set() calls from two instances must both end up on disk.
    a.set('openai', { type: 'api_key', key: 'sk-a' })
    b.set('fireworks', { type: 'api_key', key: 'fw-b' })

    const fresh = createSecretsStoreForAgent(secretsPath)
    expect(fresh.get('openai')).toEqual({ type: 'api_key', key: 'sk-a' })
    expect(fresh.get('fireworks')).toEqual({ type: 'api_key', key: 'fw-b' })
  })

  test('mutation check: removing the wrap (using AuthStorage.create directly) breaks the envelope shape', async () => {
    // Acceptance bar from AGENTS.md §3: this test guards the wiring. If a
    // future change replaces createSecretsStoreForAgent with a plain
    // AuthStorage.create(path), the test must fail because the upstream
    // backend writes the flat shape, not our envelope.
    const store = createSecretsStoreForAgent(secretsPath)
    store.set('openai', { type: 'api_key', key: 'sk-mutation' })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as Record<string, unknown>

    // Envelope properties that would NOT exist if AuthStorage owned the file.
    expect(obj['version']).toBe(1)
    expect(obj['llm']).toBeDefined()
    expect(obj['channels']).toBeDefined()

    // Provider key would NOT be at the root if the wrap is in place.
    expect(obj['openai']).toBeUndefined()
  })
})
