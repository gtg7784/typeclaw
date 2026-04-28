import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetConfigForTesting, configSchema, FIELD_EFFECTS, getConfig } from './config'
import { createConfigReloadable } from './reloadable'

const VALID_MODEL_A = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'

describe('createConfigReloadable', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-reload-config-'))
  })

  afterEach(async () => {
    __resetConfigForTesting()
    await rm(cwd, { recursive: true, force: true })
  })

  test('atomicity: invalid JSON leaves the live config untouched', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001 }))
    const reloadable = createConfigReloadable({ cwd })

    const first = await reloadable.reload()
    expect(first.ok).toBe(true)
    expect(getConfig().port).toBe(9001)

    await writeFile(join(cwd, 'typeclaw.json'), '{ not json')
    const second = await reloadable.reload()

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain('not valid JSON')
    expect(getConfig().port).toBe(9001)
  })

  test('atomicity: schema-invalid config leaves the live config untouched', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001 }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, memory: { dreaming: { schedule: 'not-a-cron' } } }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(false)
    expect(getConfig().port).toBe(9001)
  })

  test('field fence: port and mounts changes land in `restartRequired`', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001, mounts: [] }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: VALID_MODEL_A,
        port: 9002,
        mounts: [{ name: 'projects', path: '~/projects' }],
      }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as {
      applied: unknown[]
      restartRequired: { path: string }[]
      ignored: unknown[]
    }
    const paths = diff.restartRequired.map((c) => c.path).sort()
    expect(paths).toEqual(['mounts', 'port'])
  })

  test('field fence: $schema change is ignored', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, $schema: './a.json' }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, $schema: './b.json' }))
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as {
      applied: unknown[]
      restartRequired: unknown[]
      ignored: { path: string }[]
    }
    expect(diff.applied).toHaveLength(0)
    expect(diff.restartRequired).toHaveLength(0)
    expect(diff.ignored.map((c) => c.path)).toEqual(['$schema'])
  })

  test('field fence: memory.dreaming change lands in `applied`', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, memory: { dreaming: { schedule: '0 5 * * *' } } }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as { applied: { path: string }[] }
    expect(diff.applied.map((c) => c.path)).toContain('memory.dreaming')
    expect(getConfig().memory.dreaming?.schedule).toBe('0 5 * * *')
  })

  test('summary string reports counts in each bucket', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001, $schema: './a.json' }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: VALID_MODEL_A,
        port: 9002,
        $schema: './b.json',
        memory: { dreaming: { schedule: '0 5 * * *' } },
      }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary).toBe('1 applied, 1 restart-required, 1 ignored')
  })
})

describe('FIELD_EFFECTS coverage', () => {
  test('every reachable runtime path in configSchema has a FIELD_EFFECTS entry', () => {
    const parsed = configSchema.parse({}) as Record<string, unknown>
    const schemaPaths = enumeratePaths(parsed)
    const classified = new Set(Object.keys(FIELD_EFFECTS))
    const missing = schemaPaths.filter((p) => !classified.has(p))
    expect(missing).toEqual([])
  })

  test('every FIELD_EFFECTS entry is reachable from a parsed default config or is a known optional path', () => {
    const parsed = configSchema.parse({ $schema: './x.json', memory: { dreaming: {} } }) as Record<string, unknown>
    const schemaPaths = new Set(enumeratePaths(parsed))
    const stale = Object.keys(FIELD_EFFECTS).filter((p) => !schemaPaths.has(p))
    expect(stale).toEqual([])
  })
})

function enumeratePaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    const value = obj[key]
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      shouldRecurse(path)
    ) {
      out.push(...enumeratePaths(value as Record<string, unknown>, path))
    } else {
      out.push(path)
    }
  }
  return out
}

function shouldRecurse(path: string): boolean {
  return path === 'memory'
}

