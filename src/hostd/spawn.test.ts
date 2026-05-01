import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type Daemon } from './daemon'
import { socketPath } from './paths'
import { ensureDaemon } from './spawn'

let home: string
let prev: string | undefined
let daemon: Daemon | null = null

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typeclaw-spawn-'))
  prev = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = home
  daemon = null
})

afterEach(async () => {
  if (daemon) await daemon.stop().catch(() => {})
  if (prev === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = prev
  await rm(home, { recursive: true, force: true })
})

describe('ensureDaemon', () => {
  test('reuses a reachable daemon when the version matches', async () => {
    daemon = await startDaemon({
      version: 'matching-hash',
      gcIntervalMs: 1_000_000,
    })

    const result = await ensureDaemon({
      brokerEntry: '/nowhere/cli.ts',
      expectedVersion: 'matching-hash',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spawned).toBe(false)
    expect(result.respawned).toBe(false)
  })

  test('detects drift when the daemon advertises a different version, shuts it down, then attempts a respawn', async () => {
    daemon = await startDaemon({
      version: 'old',
      gcIntervalMs: 1_000_000,
    })
    expect(existsSync(socketPath())).toBe(true)

    const result = await ensureDaemon({
      brokerEntry: '/nonexistent/cli.ts',
      expectedVersion: 'new',
      spawnTimeoutMs: 500,
    })

    // After detecting drift, ensureDaemon sends `shutdown` and waits for the
    // socket to disappear (which it does, because daemon.stop unlinks it).
    // Then it tries to respawn the daemon at the dummy brokerEntry, which
    // fails. The end-to-end behavior we want to assert: the stale daemon was
    // torn down (socket gone) and ensureDaemon did NOT reuse it.
    daemon = null
    expect(existsSync(socketPath())).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).toContain('reachable')
  })

  test('happy path: socket missing -> spawns a new daemon (when brokerEntry resolves)', async () => {
    expect(existsSync(socketPath())).toBe(false)

    const result = await ensureDaemon({
      brokerEntry: '/nonexistent/cli.ts',
      spawnTimeoutMs: 500,
    })

    // Production path requires a real brokerEntry; the test invokes with a
    // dummy path, so spawn fails. The test asserts the failure mode is the
    // spawn failure (not the drift path).
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).not.toContain('drift')
  })
})
