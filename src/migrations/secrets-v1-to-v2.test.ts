import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseSecretsFile } from '@/secrets/schema'

import { migrateSecretsV1ToV2 } from './secrets-v1-to-v2'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-secrets-mig-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeSecrets(name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`)
}

function readSecrets(name = 'secrets.json'): unknown {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'))
}

describe('migrateSecretsV1ToV2 — v1 envelope', () => {
  test('upgrades env-keyed discord channel to field-keyed v2 Secret so the bot reconnects', () => {
    writeSecrets('secrets.json', {
      version: 1,
      llm: {},
      channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'discord-secret' } },
    })

    const result = migrateSecretsV1ToV2(dir)

    expect(result.changed).toBe(true)
    const parsed = parseSecretsFile(readSecrets())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.channels['discord-bot']).toEqual({ token: { value: 'discord-secret' } })
  })

  test('upgrades both slack token fields to their v2 field names', () => {
    writeSecrets('secrets.json', {
      version: 1,
      llm: {},
      channels: { 'slack-bot': { SLACK_BOT_TOKEN: 'xoxb', SLACK_APP_TOKEN: 'xapp' } },
    })

    migrateSecretsV1ToV2(dir)

    const parsed = parseSecretsFile(readSecrets())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.channels['slack-bot']).toEqual({
      botToken: { value: 'xoxb' },
      appToken: { value: 'xapp' },
    })
  })

  test('renames llm to providers and wraps api-key string into a Secret', () => {
    writeSecrets('secrets.json', {
      version: 1,
      llm: { openai: { type: 'api_key', key: 'sk-legacy' } },
      channels: {},
    })

    migrateSecretsV1ToV2(dir)

    const parsed = parseSecretsFile(readSecrets())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.providers.openai).toEqual({ type: 'api_key', key: { value: 'sk-legacy' } })
  })

  test('passes oauth provider credentials through verbatim', () => {
    writeSecrets('secrets.json', {
      version: 1,
      llm: { anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 123 } },
      channels: {},
    })

    migrateSecretsV1ToV2(dir)

    const parsed = parseSecretsFile(readSecrets())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.providers.anthropic).toEqual({ type: 'oauth', access: 'a', refresh: 'r', expires: 123 })
  })

  test('keeps the mapped token but lets v2 validation drop an unknown field on a known adapter', () => {
    writeSecrets('secrets.json', {
      version: 1,
      llm: {},
      channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 't', WEIRD_EXTRA: 'x' } },
    })

    migrateSecretsV1ToV2(dir)

    const slot = (readSecrets() as { channels: Record<string, Record<string, unknown>> }).channels['discord-bot']
    expect(slot).toEqual({ token: { value: 't' } })
  })

  test('preserves an unknown adapter id, wrapping its string fields as Secrets', () => {
    writeSecrets('secrets.json', {
      version: 1,
      llm: {},
      channels: { 'future-bot': { SOME_TOKEN: 'v' } },
    })

    migrateSecretsV1ToV2(dir)

    const channels = (readSecrets() as { channels: Record<string, unknown> }).channels
    expect(channels['future-bot']).toEqual({ SOME_TOKEN: { value: 'v' } })
  })

  test('preserves a structured (non-string) channel block such as kakaotalk verbatim', () => {
    const kakao = { currentAccount: null, accounts: {} }
    writeSecrets('secrets.json', { version: 1, llm: {}, channels: { kakaotalk: kakao } })

    migrateSecretsV1ToV2(dir)

    const channels = (readSecrets() as { channels: Record<string, unknown> }).channels
    expect(channels.kakaotalk).toEqual(kakao)
  })

  test('writes the v2 version stamp', () => {
    writeSecrets('secrets.json', { version: 1, llm: {}, channels: {} })

    migrateSecretsV1ToV2(dir)

    expect((readSecrets() as { version: number }).version).toBe(2)
  })
})

describe('migrateSecretsV1ToV2 — pre-envelope flat shape', () => {
  test('treats a top-level provider record as v1 llm and upgrades it', () => {
    writeSecrets('secrets.json', { openai: { type: 'api_key', key: 'sk-flat' } })

    const result = migrateSecretsV1ToV2(dir)

    expect(result.changed).toBe(true)
    const parsed = parseSecretsFile(readSecrets())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.providers.openai).toEqual({ type: 'api_key', key: { value: 'sk-flat' } })
    expect(parsed.file.channels).toEqual({})
  })
})

describe('migrateSecretsV1ToV2 — idempotency & no-op', () => {
  test('a v2 file is left unchanged', () => {
    const v2 = {
      $schema: './node_modules/typeclaw/secrets.schema.json',
      version: 2,
      providers: { openai: { type: 'api_key', key: { value: 'sk' } } },
      channels: { 'discord-bot': { token: { value: 't' } } },
    }
    writeSecrets('secrets.json', v2)
    const before = readFileSync(join(dir, 'secrets.json'), 'utf8')

    const result = migrateSecretsV1ToV2(dir)

    expect(result.changed).toBe(false)
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(before)
  })

  test('running twice on a v1 file is stable', () => {
    writeSecrets('secrets.json', {
      version: 1,
      llm: {},
      channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'd' } },
    })

    const first = migrateSecretsV1ToV2(dir)
    const afterFirst = readFileSync(join(dir, 'secrets.json'), 'utf8')
    const second = migrateSecretsV1ToV2(dir)

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(afterFirst)
  })

  test('no secrets file at all is a no-op', () => {
    const result = migrateSecretsV1ToV2(dir)
    expect(result.changed).toBe(false)
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false)
  })
})

describe('migrateSecretsV1ToV2 — legacy auth.json precedence', () => {
  test('only auth.json: renames to secrets.json and upgrades it', () => {
    writeSecrets('auth.json', {
      version: 1,
      llm: {},
      channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'd' } },
    })

    const result = migrateSecretsV1ToV2(dir)

    expect(result.changed).toBe(true)
    expect(existsSync(join(dir, 'auth.json'))).toBe(false)
    const parsed = parseSecretsFile(readSecrets())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.channels['discord-bot']).toEqual({ token: { value: 'd' } })
  })

  test('both files, auth.json empty: drops auth.json and keeps secrets.json', () => {
    writeSecrets('auth.json', { version: 2, providers: {}, channels: {} })
    writeSecrets('secrets.json', {
      version: 2,
      providers: { openai: { type: 'api_key', key: { value: 'sk' } } },
      channels: {},
    })

    migrateSecretsV1ToV2(dir)

    expect(existsSync(join(dir, 'auth.json'))).toBe(false)
    const parsed = parseSecretsFile(readSecrets())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.providers.openai).toBeDefined()
  })

  test('both files, secrets.json empty: auth.json wins and is upgraded', () => {
    writeSecrets('auth.json', {
      version: 1,
      llm: {},
      channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'from-auth' } },
    })
    writeSecrets('secrets.json', { version: 2, providers: {}, channels: {} })

    migrateSecretsV1ToV2(dir)

    expect(existsSync(join(dir, 'auth.json'))).toBe(false)
    const parsed = parseSecretsFile(readSecrets())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.channels['discord-bot']).toEqual({ token: { value: 'from-auth' } })
  })

  test('both files non-empty: throws rather than guess a source of truth', () => {
    writeSecrets('auth.json', {
      version: 1,
      llm: { openai: { type: 'api_key', key: 'from-auth' } },
      channels: {},
    })
    writeSecrets('secrets.json', {
      version: 2,
      providers: { openai: { type: 'api_key', key: { value: 'from-secrets' } } },
      channels: {},
    })

    expect(() => migrateSecretsV1ToV2(dir)).toThrow(/both/i)
  })

  test('both files, auth.json parseable-but-unrecognized: throws and keeps auth.json instead of dropping it', () => {
    writeSecrets('auth.json', { something: 'we do not recognize', nested: { a: 1 } })
    writeSecrets('secrets.json', {
      version: 2,
      providers: { openai: { type: 'api_key', key: { value: 'from-secrets' } } },
      channels: {},
    })

    expect(() => migrateSecretsV1ToV2(dir)).toThrow(/both/i)
    expect(existsSync(join(dir, 'auth.json'))).toBe(true)
  })
})

describe('migrateSecretsV1ToV2 — unsafe / unrecognized input', () => {
  test('throws on a non-empty file that is neither v2 nor a known legacy shape', () => {
    writeSecrets('secrets.json', { version: 1, channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 42 } }, junk: true })
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ totally: 'unknown', nested: { a: 1 } }))

    expect(() => migrateSecretsV1ToV2(dir)).toThrow()
  })

  test('throws on invalid JSON rather than silently dropping the file', () => {
    writeFileSync(join(dir, 'secrets.json'), '{ not valid json')

    expect(() => migrateSecretsV1ToV2(dir)).toThrow(/JSON/i)
  })
})

describe('migrateSecretsV1ToV2 — concurrency', () => {
  test('releases the secrets.json lock after a successful migration', () => {
    writeSecrets('auth.json', {
      version: 1,
      llm: {},
      channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'd' } },
    })

    migrateSecretsV1ToV2(dir)

    expect(existsSync(join(dir, 'secrets.json.lock'))).toBe(false)
  })

  test('seeding never overwrites an existing non-empty secrets.json (no clobber when only that file is present)', () => {
    const v2 = {
      $schema: './node_modules/typeclaw/secrets.schema.json',
      version: 2,
      providers: { openai: { type: 'api_key', key: { value: 'keep-me' } } },
      channels: {},
    }
    writeSecrets('secrets.json', v2)
    const before = readFileSync(join(dir, 'secrets.json'), 'utf8')

    const result = migrateSecretsV1ToV2(dir)

    expect(result.changed).toBe(false)
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(before)
  })
})
