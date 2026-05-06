import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DockerExec } from '@/container'

import { send, sendHttp } from './client'
import { startDaemon, type Daemon, type PortbrokerCallbacks, type PortbrokerStartInput } from './daemon'
import { registrationFilePath, registrationsDir, socketPath } from './paths'
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

  test('status returns the registered cwd with empty forwardedPorts when no portbroker is wired', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })

    const status = await send({ kind: 'status', containerName: 'coder' })
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.result).toEqual({ containerName: 'coder', cwd: '/x', forwardedPorts: [] })
  })

  test('status surfaces forwardedPorts reported by the portbroker callback', async () => {
    const portbroker: PortbrokerCallbacks = {
      start: () => {},
      stop: async () => {},
      forwardedPorts: (name) => (name === 'coder' ? [3000, 5173] : []),
    }
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, portbroker })
    await send({
      kind: 'register',
      containerName: 'coder',
      cwd: '/x',
      wsHostPort: 12345,
      portForward: { allow: '*' },
      brokerToken: 'tok',
    })

    const status = await send({ kind: 'status', containerName: 'coder' })
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.result).toEqual({ containerName: 'coder', cwd: '/x', forwardedPorts: [3000, 5173] })
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
    const restartCalls: Array<{ containerName: string; cwd: string; build?: boolean }> = []
    daemon = await startDaemon({
      exec: fakeExec(new Set(['coder'])),
      gcIntervalMs: 1_000_000,
      restart: async ({ containerName, cwd, build }) => {
        restartCalls.push({ containerName, cwd, build })
        return { ok: true }
      },
    })

    await send({ kind: 'register', containerName: 'coder', cwd: '/agent/coder' })
    const ack = await send({ kind: 'restart', containerName: 'coder' })
    expect(ack.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(restartCalls).toEqual([{ containerName: 'coder', cwd: '/agent/coder', build: false }])
  })

  test('restart RPC forwards build:true to the supervisor', async () => {
    const restartCalls: Array<{ containerName: string; cwd: string; build?: boolean }> = []
    daemon = await startDaemon({
      exec: fakeExec(new Set(['coder'])),
      gcIntervalMs: 1_000_000,
      restart: async ({ containerName, cwd, build }) => {
        restartCalls.push({ containerName, cwd, build })
        return { ok: true }
      },
    })

    await send({ kind: 'register', containerName: 'coder', cwd: '/agent/coder' })
    const ack = await send({ kind: 'restart', containerName: 'coder', build: true })
    expect(ack.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(restartCalls).toEqual([{ containerName: 'coder', cwd: '/agent/coder', build: true }])
  })

  test('restart RPC rejects a non-boolean build field', async () => {
    daemon = await startDaemon({
      exec: fakeExec(new Set(['coder'])),
      gcIntervalMs: 1_000_000,
      restart: async () => ({ ok: true }),
    })

    await send({ kind: 'register', containerName: 'coder', cwd: '/agent/coder' })
    const ack = await send({ kind: 'restart', containerName: 'coder', build: 'yes' as unknown as boolean })
    expect(ack.ok).toBe(false)
    if (ack.ok) return
    expect(ack.reason).toContain('boolean')
  })

  test('restart RPC returns preflight rejection before scheduling supervisor work', async () => {
    const restartCalls: Array<{ containerName: string; cwd: string; build?: boolean }> = []
    daemon = await startDaemon({
      exec: fakeExec(new Set(['coder'])),
      gcIntervalMs: 1_000_000,
      restartPreflight: async () => ({ ok: false, reason: 'source drift' }),
      restart: async ({ containerName, cwd, build }) => {
        restartCalls.push({ containerName, cwd, build })
        return { ok: true }
      },
    })

    await send({ kind: 'register', containerName: 'coder', cwd: '/agent/coder' })
    const ack = await send({ kind: 'restart', containerName: 'coder', build: true })

    expect(ack).toEqual({ ok: false, reason: 'source drift' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(restartCalls).toEqual([])
  })

  test('HTTP restart ACKs with the registered container token', async () => {
    const restartCalls: Array<{ containerName: string; cwd: string; build?: boolean }> = []
    daemon = await startDaemon({
      exec: fakeExec(new Set(['coder'])),
      gcIntervalMs: 1_000_000,
      restart: async ({ containerName, cwd, build }) => {
        restartCalls.push({ containerName, cwd, build })
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
    expect(restartCalls).toEqual([{ containerName: 'coder', cwd: '/agent/coder', build: false }])
  })

  test('HTTP restart forwards build:true to the supervisor', async () => {
    const restartCalls: Array<{ containerName: string; cwd: string; build?: boolean }> = []
    daemon = await startDaemon({
      exec: fakeExec(new Set(['coder'])),
      gcIntervalMs: 1_000_000,
      restart: async ({ containerName, cwd, build }) => {
        restartCalls.push({ containerName, cwd, build })
        return { ok: true }
      },
    })
    const info = await send({ kind: 'http-info' })
    expect(info.ok).toBe(true)
    if (!info.ok) return
    const port = (info.result as HttpInfoResult).port

    await send({ kind: 'register', containerName: 'coder', cwd: '/agent/coder', restartToken: 'secret' })
    const ack = await sendHttp(
      { kind: 'restart', containerName: 'coder', build: true },
      { url: `http://127.0.0.1:${port}`, token: 'secret' },
    )
    expect(ack.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(restartCalls).toEqual([{ containerName: 'coder', cwd: '/agent/coder', build: true }])
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

  test('register persists the payload to registrations/<name>.json with mode 0600', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })

    const reg = await send({
      kind: 'register',
      containerName: 'coder',
      cwd: '/agent/coder',
      restartToken: 'tok-1',
      wsHostPort: 12345,
      portForward: { allow: '*' },
      brokerToken: 'broker-1',
    })
    expect(reg.ok).toBe(true)

    const filePath = registrationFilePath('coder')
    expect(existsSync(filePath)).toBe(true)

    const stats = await stat(filePath)
    expect(stats.mode & 0o777).toBe(0o600)

    const contents = JSON.parse(await readFile(filePath, 'utf8'))
    expect(contents).toEqual({
      containerName: 'coder',
      cwd: '/agent/coder',
      restartToken: 'tok-1',
      wsHostPort: 12345,
      portForward: { allow: '*' },
      brokerToken: 'broker-1',
    })
  })

  test('deregister unlinks the persisted registration file', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
    await send({ kind: 'register', containerName: 'coder', cwd: '/agent/coder' })
    expect(existsSync(registrationFilePath('coder'))).toBe(true)

    await send({ kind: 'deregister', containerName: 'coder' })
    expect(existsSync(registrationFilePath('coder'))).toBe(false)
  })

  test('persisted registrations survive daemon respawn (HTTP restart works against a fresh daemon)', async () => {
    const restartCalls: Array<{ containerName: string; cwd: string }> = []
    const restart = async ({ containerName, cwd }: { containerName: string; cwd: string }) => {
      restartCalls.push({ containerName, cwd })
      return { ok: true as const }
    }

    const d1 = await startDaemon({ exec: fakeExec(new Set(['coder'])), gcIntervalMs: 1_000_000, restart })
    await send({
      kind: 'register',
      containerName: 'coder',
      cwd: '/agent/coder',
      restartToken: 'tok-survives',
    })
    await d1.stop()

    daemon = await startDaemon({ exec: fakeExec(new Set(['coder'])), gcIntervalMs: 1_000_000, restart })

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations).toEqual([{ containerName: 'coder', cwd: '/agent/coder' }])

    const httpInfo = await send({ kind: 'http-info' })
    expect(httpInfo.ok).toBe(true)
    if (!httpInfo.ok) return
    const port = (httpInfo.result as HttpInfoResult).port

    const ack = await sendHttp(
      { kind: 'restart', containerName: 'coder' },
      { url: `http://127.0.0.1:${port}`, token: 'tok-survives' },
    )
    expect(ack.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(restartCalls).toEqual([{ containerName: 'coder', cwd: '/agent/coder' }])
  })

  test('boot-time restore tolerates corrupted registration files', async () => {
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
    await send({ kind: 'register', containerName: 'good', cwd: '/agent/good' })
    await daemon.stop()

    await writeFile(join(registrationsDir(), 'broken.json'), '{ this is not json')
    await writeFile(join(registrationsDir(), 'mismatch.json'), JSON.stringify({ containerName: 'other', cwd: '/x' }))

    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations.map((r) => r.containerName).sort()).toEqual(['good'])
  })

  test('boot-time restore revives portbroker for persisted registrations with portbroker fields', async () => {
    const startCalls: PortbrokerStartInput[] = []
    const portbroker: PortbrokerCallbacks = {
      start: (input) => {
        startCalls.push(input)
      },
      stop: async () => {},
      forwardedPorts: () => [],
    }

    const d1 = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, portbroker })
    await send({
      kind: 'register',
      containerName: 'with-broker',
      cwd: '/agent/with-broker',
      restartToken: 't',
      wsHostPort: 54321,
      portForward: { allow: '*' },
      brokerToken: 'btok',
    })
    await d1.stop()

    startCalls.length = 0
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, portbroker })

    expect(startCalls).toHaveLength(1)
    expect(startCalls[0]?.containerName).toBe('with-broker')
    expect(startCalls[0]?.cwd).toBe('/agent/with-broker')
    expect(startCalls[0]?.wsHostPort).toBe(54321)
    expect(startCalls[0]?.brokerToken).toBe('btok')
  })

  test('HTTP control falls back to an ephemeral port when the preferred port is busy', async () => {
    const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('blocker') })
    try {
      const events: Array<{ kind: string; preferred?: number; actual?: number }> = []
      daemon = await startDaemon({
        exec: fakeExec(),
        gcIntervalMs: 1_000_000,
        httpPort: blocker.port,
        httpHost: '127.0.0.1',
        onLog: (event) => {
          if (event.kind === 'daemon-http-port-fallback' || event.kind === 'daemon-http-listening') {
            events.push(event as { kind: string; preferred?: number; actual?: number })
          }
        },
      })

      const fallback = events.find((e) => e.kind === 'daemon-http-port-fallback')
      const listening = events.find((e) => e.kind === 'daemon-http-listening')
      expect(fallback).toBeDefined()
      expect(fallback!.preferred).toBe(blocker.port)
      expect(listening).toBeDefined()
      expect(listening!.actual ?? 0).not.toBe(blocker.port)
    } finally {
      blocker.stop(true)
    }
  })

  test('HTTP control uses the preferred port when it is free', async () => {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') })
    const candidatePort = probe.port
    probe.stop(true)

    const events: Array<{ kind: string; port?: number }> = []
    daemon = await startDaemon({
      exec: fakeExec(),
      gcIntervalMs: 1_000_000,
      httpPort: candidatePort,
      httpHost: '127.0.0.1',
      onLog: (event) => {
        if (event.kind === 'daemon-http-listening') events.push(event as { kind: string; port?: number })
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.port).toBe(candidatePort)
  })
})
