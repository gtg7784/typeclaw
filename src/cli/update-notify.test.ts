import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decideUpdateAction } from './update-notify'
import { shouldConsiderUpdateNotice } from './update-suppression'

beforeEach(() => {
  process.env.NO_COLOR = '1'
})
afterEach(() => {
  delete process.env.NO_COLOR
})

describe('decideUpdateAction', () => {
  const NOW = 1_000_000_000_000
  const DAY = 24 * 60 * 60 * 1000
  // Stale attempt marker so the default scenario asks for a refresh.
  const newerStaleCache = { latest: '99.0.0', checkedAt: NOW - 2 * DAY, lastAttemptAt: NOW - 2 * DAY }
  const enabled = {
    current: '0.39.2',
    isInstalled: true,
    configEnabled: true,
    env: {} as Record<string, string | undefined>,
    cache: newerStaleCache,
    now: NOW,
  }

  test('enabled + newer + stale cache: notice rendered and refresh requested', () => {
    const action = decideUpdateAction(enabled)
    expect(action.notice).toContain('99.0.0')
    expect(action.refresh).toBe(true)
  })

  test('config disabled suppresses BOTH notice and refresh (review #1)', () => {
    const action = decideUpdateAction({ ...enabled, configEnabled: false })
    expect(action.notice).toBeNull()
    expect(action.refresh).toBe(false)
  })

  test('env opt-out suppresses BOTH notice and refresh, even with a newer cache', () => {
    const action = decideUpdateAction({ ...enabled, env: { TYPECLAW_NO_UPDATE_CHECK: '1' } })
    expect(action.notice).toBeNull()
    expect(action.refresh).toBe(false)
  })

  test('dev checkout suppresses BOTH notice and refresh', () => {
    const action = decideUpdateAction({ ...enabled, isInstalled: false })
    expect(action.notice).toBeNull()
    expect(action.refresh).toBe(false)
  })

  test('enabled but no cache: no notice, refresh requested (nothing fresh to throttle on)', () => {
    const action = decideUpdateAction({ ...enabled, cache: null })
    expect(action.notice).toBeNull()
    expect(action.refresh).toBe(true)
  })

  test('a fresh success cache still renders the notice but suppresses the refresh (review)', () => {
    const action = decideUpdateAction({
      ...enabled,
      cache: { latest: '99.0.0', checkedAt: NOW - 1000, lastAttemptAt: NOW - 1000 },
    })
    expect(action.notice).toContain('99.0.0')
    expect(action.refresh).toBe(false)
  })

  test('a fresh failure-only cache suppresses the refresh (no respawn-on-every-call, review)', () => {
    const action = decideUpdateAction({ ...enabled, cache: { lastAttemptAt: NOW - 1000 } })
    expect(action.notice).toBeNull()
    expect(action.refresh).toBe(false)
  })
})

describe('shouldConsiderUpdateNotice', () => {
  test('considers real host builtin commands', () => {
    expect(shouldConsiderUpdateNotice('start')).toBe(true)
    expect(shouldConsiderUpdateNotice('tui')).toBe(true)
    expect(shouldConsiderUpdateNotice('logs')).toBe(true)
    expect(shouldConsiderUpdateNotice('status')).toBe(true)
  })

  test('suppresses the container stage and self-update', () => {
    expect(shouldConsiderUpdateNotice('run')).toBe(false)
    expect(shouldConsiderUpdateNotice('update')).toBe(false)
  })

  test('suppresses hidden internals', () => {
    expect(shouldConsiderUpdateNotice('_hostd')).toBe(false)
    expect(shouldConsiderUpdateNotice('_update-check')).toBe(false)
  })

  test('suppresses bare flags and empty invocations', () => {
    expect(shouldConsiderUpdateNotice('--help')).toBe(false)
    expect(shouldConsiderUpdateNotice('-v')).toBe(false)
    expect(shouldConsiderUpdateNotice(undefined)).toBe(false)
  })

  test('suppresses unknown (plugin) commands', () => {
    expect(shouldConsiderUpdateNotice('some-plugin-command')).toBe(false)
  })
})

// End-to-end CLI behavior: the notice gate is observable only as stderr output,
// so these run the real binary with a planted newer-version cache and assert the
// disabled paths stay silent. This is the regression guard for review #1 — the
// skip decision must gate the rendered notice, not just the background refresh.
// (The positive "enabled => notice" case can't run from a source checkout: the
// dev-checkout skip suppresses it by design; renderUpdateNotice covers that
// path directly above.)
describe('maybeNotifyUpdate (end-to-end notice gating)', () => {
  const CLI_ENTRY = join(import.meta.dir, 'index.ts')

  async function runStatus(home: string, env: Record<string, string>): Promise<string> {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'status'],
      env: { ...process.env, TYPECLAW_HOME: home, NO_COLOR: '1', ...env },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    return stderr
  }

  async function withSeededCache(fn: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'typeclaw-notify-'))
    try {
      await writeFile(
        join(home, 'version-cache.json'),
        JSON.stringify({ latest: '99.0.0', checkedAt: Date.now(), lastAttemptAt: Date.now() }),
      )
      await fn(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  test('prints nothing when TYPECLAW_NO_UPDATE_CHECK is set, even with a newer cache', async () => {
    await withSeededCache(async (home) => {
      const stderr = await runStatus(home, { TYPECLAW_NO_UPDATE_CHECK: '1' })
      expect(stderr).not.toContain('Update available')
    })
  })

  test('prints nothing in CI mode, even with a newer cache', async () => {
    await withSeededCache(async (home) => {
      const stderr = await runStatus(home, { CI: 'true' })
      expect(stderr).not.toContain('Update available')
    })
  })
})

// Structural guard for the review fix: the env/dev/non-release skip must be able
// to run before @/config is loaded, which is only true if this module never
// statically imports config. A behavioral e2e can't isolate this (every real
// builtin pulls @/config transitively), so we assert the source structure
// directly — a regression that re-adds the eager import fails here.
describe('update-notify module does not eagerly load @/config', () => {
  test('no top-level @/config import', async () => {
    const source = await readFile(join(import.meta.dir, 'update-notify.ts'), 'utf8')
    const topLevelConfigImport = /^import\s[^\n]*from\s+['"]@\/config['"]/m
    expect(topLevelConfigImport.test(source)).toBe(false)
  })
})
