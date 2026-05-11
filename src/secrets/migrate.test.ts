import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrateLegacyAuthJson } from './migrate'
import { createSecretsStoreForAgent } from './storage'

describe('migrateLegacyAuthJson', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-secrets-migrate-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('renames auth.json to secrets.json when only the legacy file exists', async () => {
    const legacy = join(dir, 'auth.json')
    const payload = JSON.stringify({
      version: 1,
      llm: { fireworks: { type: 'api_key', key: 'fw-legacy' } },
      channels: {},
    })
    await writeFile(legacy, payload)

    migrateLegacyAuthJson(dir)

    const target = join(dir, 'secrets.json')
    expect(await readFile(target, 'utf8')).toBe(payload)
    await expect(readFile(legacy, 'utf8')).rejects.toThrow()
  })

  test('is a no-op when only secrets.json exists', async () => {
    const target = join(dir, 'secrets.json')
    const payload = JSON.stringify({ version: 1, llm: {}, channels: {} })
    await writeFile(target, payload)

    migrateLegacyAuthJson(dir)

    expect(await readFile(target, 'utf8')).toBe(payload)
  })

  test('is a no-op when neither file exists', () => {
    expect(() => migrateLegacyAuthJson(dir)).not.toThrow()
  })

  test('deletes auth.json when it is the empty seed envelope and secrets.json already exists', async () => {
    const legacy = join(dir, 'auth.json')
    const target = join(dir, 'secrets.json')
    const emptyEnvelope = JSON.stringify({
      $schema: './node_modules/typeclaw/auth.schema.json',
      version: 1,
      llm: {},
      channels: {},
    })
    const realPayload = JSON.stringify({
      version: 1,
      llm: { openai: { type: 'api_key', key: 'sk-keep' } },
      channels: {},
    })
    await writeFile(legacy, emptyEnvelope)
    await writeFile(target, realPayload)

    migrateLegacyAuthJson(dir)

    expect(await readFile(target, 'utf8')).toBe(realPayload)
    await expect(readFile(legacy, 'utf8')).rejects.toThrow()
  })

  test('overwrites secrets.json when it is the empty seed envelope and auth.json carries real credentials', async () => {
    const legacy = join(dir, 'auth.json')
    const target = join(dir, 'secrets.json')
    const realPayload = JSON.stringify({
      version: 1,
      llm: { openai: { type: 'api_key', key: 'sk-promote' } },
      channels: {},
    })
    const emptyEnvelope = JSON.stringify({
      $schema: './node_modules/typeclaw/secrets.schema.json',
      version: 1,
      llm: {},
      channels: {},
    })
    await writeFile(legacy, realPayload)
    await writeFile(target, emptyEnvelope)

    migrateLegacyAuthJson(dir)

    expect(await readFile(target, 'utf8')).toBe(realPayload)
    await expect(readFile(legacy, 'utf8')).rejects.toThrow()
  })

  test('throws when both files exist and both carry real credentials', async () => {
    const legacy = join(dir, 'auth.json')
    const target = join(dir, 'secrets.json')
    await writeFile(
      legacy,
      JSON.stringify({ version: 1, llm: { openai: { type: 'api_key', key: 'sk-old' } }, channels: {} }),
    )
    await writeFile(
      target,
      JSON.stringify({ version: 1, llm: { fireworks: { type: 'api_key', key: 'fw-new' } }, channels: {} }),
    )

    expect(() => migrateLegacyAuthJson(dir)).toThrow(/Both auth\.json and a non-empty secrets\.json/)
  })

  test('throws when both exist and the legacy file is unparseable garbage', async () => {
    const legacy = join(dir, 'auth.json')
    const target = join(dir, 'secrets.json')
    await writeFile(legacy, '{ not json at all')
    await writeFile(
      target,
      JSON.stringify({ version: 1, llm: { openai: { type: 'api_key', key: 'sk-x' } }, channels: {} }),
    )

    // Unparseable + target non-empty must fail loudly; isEmptyEnvelope returns
    // false for unparseable input, so we hit the "both non-empty" branch.
    expect(() => migrateLegacyAuthJson(dir)).toThrow(/Both auth\.json and a non-empty secrets\.json/)
  })

  test('preserves 0o600 file mode across the rename', async () => {
    const legacy = join(dir, 'auth.json')
    const target = join(dir, 'secrets.json')
    await writeFile(
      legacy,
      JSON.stringify({ version: 1, llm: { openai: { type: 'api_key', key: 'sk-mode' } }, channels: {} }),
    )
    chmodSync(legacy, 0o600)

    migrateLegacyAuthJson(dir)

    const perms = statSync(target).mode & 0o777
    expect(perms).toBe(0o600)
  })

  test('integrates with createSecretsStoreForAgent: legacy file is migrated transparently', async () => {
    // Mutation-check anchor (AGENTS.md §3): if the call to migrateLegacyAuthJson
    // in createSecretsStoreForAgent is removed, this test fails because the
    // store opens an empty secrets.json instead of inheriting the legacy data.
    const legacy = join(dir, 'auth.json')
    const target = join(dir, 'secrets.json')
    await writeFile(
      legacy,
      JSON.stringify({ version: 1, llm: { fireworks: { type: 'api_key', key: 'fw-via-create' } }, channels: {} }),
    )

    const store = createSecretsStoreForAgent(target)
    expect(store.get('fireworks')).toEqual({ type: 'api_key', key: 'fw-via-create' })

    await expect(readFile(legacy, 'utf8')).rejects.toThrow()
    const reloaded = JSON.parse(await readFile(target, 'utf8')) as {
      llm: Record<string, unknown>
    }
    expect(reloaded.llm.fireworks).toEqual({ type: 'api_key', key: 'fw-via-create' })
  })
})
