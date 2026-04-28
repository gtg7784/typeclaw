import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configSchema, loadConfigSync, mountSchema, validateConfig } from './config'

const VALID_MODEL = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'

describe('configSchema', () => {
  test('defaults mounts to [] when omitted (predating the field is fine)', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.mounts).toEqual([])
  })

  test('accepts config with empty mounts array', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, mounts: [] })
    expect(parsed.mounts).toEqual([])
  })

  test('accepts config with one mount, defaulting readOnly to false', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      mounts: [{ name: 'projects', path: '~/projects' }],
    })
    expect(parsed.mounts).toEqual([{ name: 'projects', path: '~/projects', readOnly: false }])
  })

  test('preserves readOnly: true when provided', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      mounts: [{ name: 'notes', path: '~/notes', readOnly: true }],
    })
    expect(parsed.mounts[0]?.readOnly).toBe(true)
  })

  test('preserves description when provided', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      mounts: [{ name: 'src', path: '~/src', description: 'monorepo' }],
    })
    expect(parsed.mounts[0]?.description).toBe('monorepo')
  })
})

describe('configSchema memory.dreaming', () => {
  test('omits dreaming by default (memory.dreaming is undefined)', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL })
    expect(parsed.memory.dreaming).toBeUndefined()
  })

  test('fills in default schedule when memory.dreaming is present but empty', () => {
    const parsed = configSchema.parse({ model: VALID_MODEL, memory: { dreaming: {} } })
    expect(parsed.memory.dreaming?.schedule).toBe('0 4 * * *')
  })

  test('respects an explicit schedule', () => {
    const parsed = configSchema.parse({
      model: VALID_MODEL,
      memory: { dreaming: { schedule: '30 3 * * *' } },
    })
    expect(parsed.memory.dreaming?.schedule).toBe('30 3 * * *')
  })

  test('rejects an invalid cron expression in memory.dreaming.schedule', () => {
    expect(() =>
      configSchema.parse({
        model: VALID_MODEL,
        memory: { dreaming: { schedule: 'not-a-cron' } },
      }),
    ).toThrow()
  })

  test('rejects an empty schedule string', () => {
    expect(() =>
      configSchema.parse({
        model: VALID_MODEL,
        memory: { dreaming: { schedule: '' } },
      }),
    ).toThrow()
  })
})

describe('mountSchema name validation', () => {
  test.each([
    ['lowercase', 'projects'],
    ['digits', 'p1'],
    ['hyphen', 'my-project'],
    ['underscore', 'my_project'],
    ['mixed', 'a1-b2_c3'],
  ])('accepts %s name (%s)', (_kind, name) => {
    expect(() => mountSchema.parse({ name, path: '/x' })).not.toThrow()
  })

  test.each([
    ['empty', ''],
    ['uppercase', 'Projects'],
    ['leading hyphen', '-projects'],
    ['leading underscore', '_projects'],
    ['contains slash', 'my/project'],
    ['contains dot', 'my.project'],
    ['contains space', 'my project'],
  ])('rejects %s name (%s)', (_kind, name) => {
    expect(() => mountSchema.parse({ name, path: '/x' })).toThrow()
  })
})

describe('mountSchema path validation', () => {
  test('rejects empty path', () => {
    expect(() => mountSchema.parse({ name: 'p', path: '' })).toThrow()
  })

  test('accepts absolute path', () => {
    expect(() => mountSchema.parse({ name: 'p', path: '/abs/path' })).not.toThrow()
  })

  test('accepts ~-prefixed path', () => {
    expect(() => mountSchema.parse({ name: 'p', path: '~/notes' })).not.toThrow()
  })

  test("accepts relative path (resolution is the caller's problem)", () => {
    expect(() => mountSchema.parse({ name: 'p', path: './rel' })).not.toThrow()
  })
})

describe('validateConfig', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-validate-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('returns ok when typeclaw.json is missing', () => {
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('returns ok for a valid config', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL, mounts: [] }))
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('returns ok for a valid config with a mount', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL, mounts: [{ name: 'projects', path: '~/projects' }] }),
    )
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('fails on malformed JSON', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), '{ not json')
    const result = validateConfig(cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('typeclaw.json')
      expect(result.reason).toContain('not valid JSON')
    }
  })

  test('returns ok when mounts is omitted (defaults to [])', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL }))
    const result = validateConfig(cwd)
    expect(result.ok).toBe(true)
  })

  test('fails when a mount name violates the pattern', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL, mounts: [{ name: 'Bad Name', path: '/x' }] }),
    )
    const result = validateConfig(cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('mount name')
    }
  })

  test('fails when port is out of range', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL, mounts: [], port: 99999 }))
    const result = validateConfig(cwd)
    expect(result.ok).toBe(false)
  })
})

describe('loadConfigSync', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-load-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('returns schema defaults when typeclaw.json is missing (fresh agent / dev tree)', () => {
    const cfg = loadConfigSync(cwd)
    expect(cfg.port).toBe(8973)
    expect(cfg.memory.idleMs).toBe(30000)
    expect(cfg.memory.dreaming).toBeUndefined()
    expect(cfg.mounts).toEqual([])
  })

  test('reads memory.dreaming.schedule from disk so dreaming actually picks up user config', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: VALID_MODEL,
        memory: { dreaming: { schedule: '9 16 * * *' } },
      }),
    )
    const cfg = loadConfigSync(cwd)
    expect(cfg.memory.dreaming?.schedule).toBe('9 16 * * *')
  })

  test('reads port from disk', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL, port: 9999 }))
    const cfg = loadConfigSync(cwd)
    expect(cfg.port).toBe(9999)
  })

  test('throws on malformed JSON so the user sees the error at startup, not silent fallback', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), '{ not json')
    expect(() => loadConfigSync(cwd)).toThrow(/not valid JSON/)
  })

  test('throws on schema-invalid config (e.g. invalid dreaming schedule)', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: VALID_MODEL,
        memory: { dreaming: { schedule: 'not-a-cron' } },
      }),
    )
    expect(() => loadConfigSync(cwd)).toThrow(/typeclaw\.json is invalid/)
  })
})
