import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DockerExec } from '@/container'

import { send, sendHttp } from './client'
import { startDaemon, type Daemon } from './daemon'
import { socketPath } from './paths'
import type { HttpInfoResult, ListResult, VersionResult } from './protocol'

let home: string
let prev: string | undefined
let daemon: Daemon | null = null

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typeclaw-daemon-'))
  prev = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = home
  daemon = null
})

afterEach(async () => {
  if (daemon) await daemon.stop()
  if (prev === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = prev
  await rm(home, { recursive: true, force: true })
})

function fakeExec(alive: Set<string> = new Set()): DockerExec {
  return async (args) => {
    if (args[0] === 'ps') {
      const filter = args.find((a) => a.startsWith('name='))
      if (!filter) return { exitCode: 0, stdout: '', stderr: '' }
      const name = filter.replace(/^name=\^?/, '').replace(/\$$/, '')
      return { exitCode: 0, stdout: alive.has(name) ? `${name}\n` : '', stderr: '' }
    }
    return { exitCode: 1, stdout: '', stderr: 'unknown command' }
  }
}

describe('startDaemon', () => {
  test('register tracks a container cwd; list reflects the registration', async () => {
    daemon = await startDaemon({ exec: fakeExec(new Set(['coder'])), gcIntervalMs: 1_000_000 })

    const reg = await send({ kind: 'register', containerName: 'coder', cwd: '/tmp/coder' })
    expect(reg.ok).toBe(true)

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations).toEqual([{ containerName: 'coder', cwd: '/tmp/coder' }])
  })

  test('register is idempotent for the same container', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
    expect((await send({ kind: 'register', containerName: 'coder', cwd: '/x' })).ok).toBe(true)
    expect((await send({ kind: 'register', containerName: 'coder', cwd: '/x' })).ok).toBe(true)

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations).toHaveLength(1)
  })

  test('deregister removes the registration; list shows it gone', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })
    expect((await send({ kind: 'deregister', containerName: 'coder' })).ok).toBe(true)
    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations).toHaveLength(0)
  })

  test('status returns the registered cwd', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })

    const status = await send({ kind: 'status', containerName: 'coder' })
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.result).toEqual({ containerName: 'coder', cwd: '/x' })
  })

  test('deregister of unknown container is a no-op (ok)', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
    expect((await send({ kind: 'deregister', containerName: 'never' })).ok).toBe(true)
  })

  test('GC removes registrations whose containers vanished', async () => {
    const alive = new Set(['coder'])
    daemon = await startDaemon({ exec: fakeExec(alive), gcIntervalMs: 30, gcMissesToDeregister: 1 })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })
    alive.delete('coder')

    const start = Date.now()
    while (Date.now() - start < 1500) {
      const list = await send({ kind: 'list' })
      if (list.ok && (list.result as ListResult).registrations.length === 0) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error('GC did not remove dead container in time')
  })

  test('GC requires gcMissesToDeregister consecutive absences before deregistering', async () => {
    const alive = new Set(['coder'])
    daemon = await startDaemon({ exec: fakeExec(alive), gcIntervalMs: 20, gcMissesToDeregister: 3 })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })

    alive.delete('coder')
    await new Promise((resolve) => setTimeout(resolve, 30))
    alive.add('coder')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations.map((r) => r.containerName)).toContain('coder')
  })

  test('GC tolerates docker ps failures (status=unknown does not count as gone)', async () => {
    let psFails = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'ps') {
        psFails += 1
        return { exitCode: 1, stdout: '', stderr: 'docker daemon hiccup' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unknown' }
    }
    daemon = await startDaemon({ exec, gcIntervalMs: 20, gcMissesToDeregister: 1 })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(psFails).toBeGreaterThan(0)
    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations.map((r) => r.containerName)).toContain('coder')
  })

  test('register concurrent with deregister is serialized: no registration remains', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })

    const [reg, dereg] = await Promise.all([
      send({ kind: 'register', containerName: 'coder', cwd: '/x' }),
      send({ kind: 'deregister', containerName: 'coder' }),
    ])
    expect(reg.ok).toBe(true)
    expect(dereg.ok).toBe(true)

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations).toHaveLength(0)
  })

  test('startDaemon refuses to bind when an existing daemon is reachable', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })

    await expect(startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })).rejects.toThrow(/already listening/)
  })

  test('restart RPC ACKs and invokes the supervisor with the registered cwd', async () => {
    const restartCalls: Array<{ containerName: string; cwd: string }> = []
    daemon = await startDaemon({
      exec: fakeExec(new Set(['coder'])),
      gcIntervalMs: 1_000_000,
      restart: async ({ containerName, cwd }) => {
        restartCalls.push({ containerName, cwd })
        return { ok: true }
      },
    })

    await send({ kind: 'register', containerName: 'coder', cwd: '/agent/coder' })
    const ack = await send({ kind: 'restart', containerName: 'coder' })
    expect(ack.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(restartCalls).toEqual([{ containerName: 'coder', cwd: '/agent/coder' }])
  })

  test('HTTP restart ACKs with the registered container token', async () => {
    const restartCalls: Array<{ containerName: string; cwd: string }> = []
    daemon = await startDaemon({
      exec: fakeExec(new Set(['coder'])),
      gcIntervalMs: 1_000_000,
      restart: async ({ containerName, cwd }) => {
        restartCalls.push({ containerName, cwd })
        return { ok: true }
      },
    })
    const info = await send({ kind: 'http-info' })
    expect(info.ok).toBe(true)
    if (!info.ok) return
    const port = (info.result as HttpInfoResult).port

    await send({ kind: 'register', containerName: 'coder', cwd: '/agent/coder', restartToken: 'secret' })
    const ack = await sendHttp(
      { kind: 'restart', containerName: 'coder' },
      { url: `http://127.0.0.1:${port}`, token: 'secret' },
    )
    expect(ack.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(restartCalls).toEqual([{ containerName: 'coder', cwd: '/agent/coder' }])
  })

  test('HTTP restart rejects an invalid container token', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, restart: async () => ({ ok: true }) })
    const info = await send({ kind: 'http-info' })
    expect(info.ok).toBe(true)
    if (!info.ok) return

    await send({ kind: 'register', containerName: 'coder', cwd: '/agent/coder', restartToken: 'secret' })
    const ack = await sendHttp(
      { kind: 'restart', containerName: 'coder' },
      { url: `http://127.0.0.1:${(info.result as HttpInfoResult).port}`, token: 'wrong' },
    )
    expect(ack.ok).toBe(false)
    if (ack.ok) return
    expect(ack.reason).toContain('invalid restart token')
  })

  test('HTTP restart rejects oversized unauthenticated requests before parsing JSON', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, restart: async () => ({ ok: true }) })
    const info = await send({ kind: 'http-info' })
    expect(info.ok).toBe(true)
    if (!info.ok) return

    const res = await fetch(`http://127.0.0.1:${(info.result as HttpInfoResult).port}/rpc`, {
      method: 'POST',
      body: '{'.repeat(70_000),
    })
    const body = (await res.json()) as { ok: false; reason: string }
    expect(res.status).toBe(401)
    expect(body.reason).toContain('missing bearer token')
  })

  test('restart RPC rejects unknown containerName (auth: scope by registered name)', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, restart: async () => ({ ok: true }) })

    const ack = await send({ kind: 'restart', containerName: 'never-registered' })
    expect(ack.ok).toBe(false)
    if (ack.ok) return
    expect(ack.reason).toContain('not registered')
  })

  test('restart RPC rejects when the daemon was started without restart capability', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })

    await send({ kind: 'register', containerName: 'sup-only', cwd: '/agent/sup-only' })
    const ack = await send({ kind: 'restart', containerName: 'sup-only' })
    expect(ack.ok).toBe(false)
    if (ack.ok) return
    expect(ack.reason).toContain('not enabled')
  })

  test('version RPC reports the captured version string', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, version: 'abcdef0123' })
    const reply = await send({ kind: 'version' })
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect((reply.result as VersionResult).version).toBe('abcdef0123')
  })

  test('version RPC falls back to "unversioned" when no version was provided', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
    const reply = await send({ kind: 'version' })
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect((reply.result as VersionResult).version).toBe('unversioned')
  })

  test('shutdown RPC ACKs, calls onShutdown, removes the socket file', async () => {
    let onShutdownCalls = 0
    daemon = await startDaemon({
      exec: fakeExec(),
      gcIntervalMs: 1_000_000,
      onShutdown: () => {
        onShutdownCalls += 1
      },
    })
    expect(existsSync(socketPath())).toBe(true)

    const ack = await send({ kind: 'shutdown' })
    expect(ack.ok).toBe(true)

    const start = Date.now()
    while (Date.now() - start < 1500) {
      if (!existsSync(socketPath()) && onShutdownCalls === 1) {
        daemon = null
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error(
      `shutdown did not complete in time (socket exists=${existsSync(socketPath())}, onShutdown calls=${onShutdownCalls})`,
    )
  })

  test('shutdown RPC is idempotent: a second shutdown after stop is still ok', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, onShutdown: () => {} })
    await send({ kind: 'shutdown' })

    const start = Date.now()
    while (Date.now() - start < 1500) {
      if (!existsSync(socketPath())) {
        daemon = null
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error('shutdown did not complete in time')
  })
})
