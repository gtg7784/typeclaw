import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MIGRATION_ID, runStartupMigrations } from './index'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-mig-runner-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('runStartupMigrations', () => {
  test('reports the secrets migration as changed when a v1 file is upgraded', () => {
    writeFileSync(
      join(dir, 'secrets.json'),
      JSON.stringify({ version: 1, llm: {}, channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'd' } } }),
    )

    const outcomes = runStartupMigrations(dir, () => {})

    const secrets = outcomes.find((o) => o.id === MIGRATION_ID)
    expect(secrets?.changed).toBe(true)
    expect(secrets?.error).toBeUndefined()
  })

  test('captures a migration throw as a per-migration error without propagating', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ version: 1, llm: { openai: { type: 'api_key', key: 'a' } }, channels: {} }),
    )
    writeFileSync(
      join(dir, 'secrets.json'),
      JSON.stringify({ version: 2, providers: { openai: { type: 'api_key', key: { value: 's' } } }, channels: {} }),
    )

    const logged: string[] = []
    const outcomes = runStartupMigrations(dir, (m) => logged.push(m))

    const secrets = outcomes.find((o) => o.id === MIGRATION_ID)
    expect(secrets?.changed).toBe(false)
    expect(secrets?.error).toBeDefined()
    expect(logged.some((m) => /failed/.test(m))).toBe(true)
  })

  test('a clean v2 folder produces no changes and logs nothing', () => {
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 2, providers: {}, channels: {} }))

    const logged: string[] = []
    const outcomes = runStartupMigrations(dir, (m) => logged.push(m))

    expect(outcomes.every((o) => !o.changed)).toBe(true)
    expect(logged).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')).version).toBe(2)
  })
})
