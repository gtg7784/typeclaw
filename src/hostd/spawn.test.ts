import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { isWindows } from '@/shared'

import { isDaemonReachable } from './client'
import { startDaemon, type Daemon } from './daemon'
import { pidfilePath, socketPath } from './paths'
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

async function expectDaemonEndpointListening(): Promise<void> {
  if (isWindows()) {
    expect(await isDaemonReachable(500)).toBe(true)
    return
  }
  expect(existsSync(socketPath())).toBe(true)
}

async function expectDaemonEndpointGone(): Promise<void> {
  if (isWindows()) {
    expect(await isDaemonReachable(50)).toBe(false)
    return
  }
  expect(existsSync(socketPath())).toBe(false)
}

describe('ensureDaemon', () => {
  test('reuses a reachable daemon when the version matches', async () => {
    daemon = await startDaemon({
      version: 'matching-hash',
      gcIntervalMs: 1_000_000,
    })

    const result = await ensureDaemon({
      cliEntry: '/nowhere/cli.ts',
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
    await expectDaemonEndpointListening()

    const result = await ensureDaemon({
      cliEntry: '/nonexistent/cli.ts',
      expectedVersion: 'new',
      spawnTimeoutMs: 100,
    })

    // After detecting drift, ensureDaemon sends `shutdown` and waits for the
    // socket to disappear (which it does, because daemon.stop unlinks it).
    // Then it tries to respawn the daemon at the dummy CLI entry, which
    // fails. The end-to-end behavior we want to assert: the stale daemon was
    // torn down (socket gone) and ensureDaemon did NOT reuse it.
    daemon = null
    await expectDaemonEndpointGone()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).toContain('reachable')
  })

  test('happy path: socket missing -> spawns a new daemon (when cliEntry resolves)', async () => {
    await expectDaemonEndpointGone()

    const result = await ensureDaemon({
      cliEntry: '/nonexistent/cli.ts',
      spawnTimeoutMs: 100,
    })

    // Production path requires a real CLI entry; the test invokes with a
    // dummy path, so the spawned child exits immediately. The test asserts the
    // failure mode is the spawn failure (not the drift path), and that an
    // EXITED child is reaped — its pidfile must not linger.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).not.toContain('drift')
    expect(result.reason.toLowerCase()).toContain('exited')
    expect(existsSync(pidfilePath())).toBe(false)
  })

  test('adopts a live-but-unreachable child instead of spawning a second daemon', async () => {
    // given: a previous spawn left a live child that never bound the socket —
    // simulated by a harmless long-lived process recorded in the pidfile
    if (isWindows()) return
    await expectDaemonEndpointGone()
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    child.unref()
    try {
      await mkdir(dirname(pidfilePath()), { recursive: true })
      await writeFile(pidfilePath(), `${child.pid}\n`)

      // when: ensureDaemon runs while that child is alive but unreachable
      const result = await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', spawnTimeoutMs: 150 })

      // then: it adopts and polls the existing child (times out), never spawning
      // a second daemon — the pidfile still points at OUR child, untouched
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('did not become reachable yet')
      expect(readFileSync(pidfilePath(), 'utf8').trim()).toBe(String(child.pid))
    } finally {
      child.kill('SIGKILL')
    }
  })
})
