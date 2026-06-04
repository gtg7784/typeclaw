import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DockerExec } from '@/container'
import type { KakaoChannelBlock } from '@/secrets/schema'
import { expectStable, waitFor } from '@/test-helpers/wait-for'

import { send, sendHttp } from './client'
import { startDaemon, type Daemon, type PortbrokerCallbacks, type PortbrokerStartInput } from './daemon'
import type { KakaoRenewalCallbacks, KakaoRenewalStartInput } from './kakao-renewal-manager'
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

function kakaoBlock(accountId: string): KakaoChannelBlock {
  return {
    currentAccount: accountId,
    accounts: {
      [accountId]: {
        account_id: accountId,
        oauth_token: `oauth-${accountId}`,
        user_id: accountId,
        refresh_token: `refresh-${accountId}`,
        device_uuid: `device-${accountId}`,
        device_type: 'tablet',
        auth_method: 'login',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    },
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
      start: async () => {},
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
    // ensure container remains registered across enough GC ticks (gcIntervalMs=20)
    // that the absence counter would have reached gcMissesToDeregister=3 if not
    // for the absence being broken by re-adding above.
    await waitFor(async () => {
      const list = await send({ kind: 'list' })
      return list.ok && (list.result as ListResult).registrations.length > 0
    })
    await expectStable(
      async () => {
        const list = await send({ kind: 'list' })
        return list.ok && (list.result as ListResult).registrations.length === 0
      },
      { durationMs: 80, intervalMs: 20, description: 'gc deregistration' },
    )

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

    await waitFor(() => psFails > 0)
    await expectStable(
      async () => {
        const list = await send({ kind: 'list' })
        return list.ok && (list.result as ListResult).registrations.length === 0
      },
      { durationMs: 100, intervalMs: 20, description: 'gc deregistration on ps failure' },
    )

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

    await waitFor(() => restartCalls.length > 0)
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

    await waitFor(() => restartCalls.length > 0)
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
    await expectStable(() => restartCalls.length > 0, { durationMs: 25, description: 'preflight-blocked restart' })
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

    await waitFor(() => restartCalls.length > 0)
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

    await waitFor(() => restartCalls.length > 0)
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

  test('HTTP secrets-patch writes kakaotalk secrets for the registered container', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-daemon-agent-'))
    try {
      daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
      const info = await send({ kind: 'http-info' })
      expect(info.ok).toBe(true)
      if (!info.ok) return
      await send({ kind: 'register', containerName: 'coder', cwd: agentDir, restartToken: 'secret' })

      const ack = await sendHttp(
        { kind: 'secrets-patch', containerName: 'coder', patch: { channels: { kakaotalk: kakaoBlock('user-1') } } },
        { url: `http://127.0.0.1:${(info.result as HttpInfoResult).port}`, token: 'secret' },
      )

      expect(ack.ok).toBe(true)
      const raw = JSON.parse(await readFile(join(agentDir, 'secrets.json'), 'utf8')) as {
        channels: Record<string, unknown>
      }
      expect(raw.channels.kakaotalk).toEqual(kakaoBlock('user-1'))
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('HTTP secrets-patch rejects unregistered containers and wrong tokens', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-daemon-agent-'))
    try {
      daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
      const info = await send({ kind: 'http-info' })
      expect(info.ok).toBe(true)
      if (!info.ok) return
      const url = `http://127.0.0.1:${(info.result as HttpInfoResult).port}`

      const unregistered = await sendHttp(
        { kind: 'secrets-patch', containerName: 'missing', patch: { channels: { kakaotalk: kakaoBlock('user-1') } } },
        { url, token: 'secret' },
      )
      expect(unregistered.ok).toBe(false)

      await send({ kind: 'register', containerName: 'coder', cwd: agentDir, restartToken: 'secret' })
      const wrongToken = await sendHttp(
        { kind: 'secrets-patch', containerName: 'coder', patch: { channels: { kakaotalk: kakaoBlock('user-1') } } },
        { url, token: 'wrong' },
      )
      expect(wrongToken.ok).toBe(false)
      if (wrongToken.ok) return
      expect(wrongToken.reason).toContain('invalid restart token')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('HTTP secrets-patch preserves other channels and serializes concurrent patches', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-daemon-agent-'))
    try {
      await writeFile(
        join(agentDir, 'secrets.json'),
        JSON.stringify({ version: 2, providers: {}, channels: { 'discord-bot': { token: { value: 'keep' } } } }),
      )
      daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000 })
      const info = await send({ kind: 'http-info' })
      expect(info.ok).toBe(true)
      if (!info.ok) return
      const url = `http://127.0.0.1:${(info.result as HttpInfoResult).port}`
      await send({ kind: 'register', containerName: 'coder', cwd: agentDir, restartToken: 'secret' })

      const replies = await Promise.all([
        sendHttp(
          { kind: 'secrets-patch', containerName: 'coder', patch: { channels: { kakaotalk: kakaoBlock('user-1') } } },
          { url, token: 'secret' },
        ),
        sendHttp(
          { kind: 'secrets-patch', containerName: 'coder', patch: { channels: { kakaotalk: kakaoBlock('user-2') } } },
          { url, token: 'secret' },
        ),
      ])

      expect(replies.every((reply) => reply.ok)).toBe(true)
      const raw = JSON.parse(await readFile(join(agentDir, 'secrets.json'), 'utf8')) as {
        channels: Record<string, unknown>
      }
      expect(raw.channels['discord-bot']).toEqual({ token: { value: 'keep' } })
      const kakao = raw.channels.kakaotalk as KakaoChannelBlock
      expect([kakaoBlock('user-1'), kakaoBlock('user-2')]).toContainEqual(kakao)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
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

  test('fatal auth failure GCs the matching registration (broker + file + list)', async () => {
    const startCalls: PortbrokerStartInput[] = []
    const stopCalls: Array<{ name: string; reason: string }> = []
    const portbroker: PortbrokerCallbacks = {
      start: async (input) => {
        startCalls.push(input)
      },
      stop: async (name, reason) => {
        stopCalls.push({ name, reason })
      },
      forwardedPorts: () => [],
    }
    daemon = await startDaemon({ exec: fakeExec(new Set(['coder'])), gcIntervalMs: 1_000_000, portbroker })
    await send({
      kind: 'register',
      containerName: 'coder',
      cwd: '/agent/coder',
      wsHostPort: 12345,
      portForward: { allow: '*' },
      brokerToken: 'T1',
    })
    expect(existsSync(registrationFilePath('coder'))).toBe(true)

    startCalls[0]?.onFatalAuthFailure?.({ brokerToken: 'T1', reason: 'invalid token' })

    await waitFor(() => !existsSync(registrationFilePath('coder')))
    expect(stopCalls).toEqual([{ name: 'coder', reason: 'fatal-auth' }])
    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations).toHaveLength(0)
  })

  test('stale fatal auth (T_old) does not delete a freshly re-registered T_new', async () => {
    const startCalls: PortbrokerStartInput[] = []
    const stopCalls: Array<{ name: string; reason: string }> = []
    const portbroker: PortbrokerCallbacks = {
      start: async (input) => {
        startCalls.push(input)
      },
      stop: async (name, reason) => {
        stopCalls.push({ name, reason })
      },
      forwardedPorts: () => [],
    }
    daemon = await startDaemon({ exec: fakeExec(new Set(['coder'])), gcIntervalMs: 1_000_000, portbroker })

    const base = {
      kind: 'register' as const,
      containerName: 'coder',
      cwd: '/agent/coder',
      wsHostPort: 12345,
      portForward: { allow: '*' as const },
    }
    await send({ ...base, brokerToken: 'T1' })
    await send({ ...base, brokerToken: 'T2' })
    expect(existsSync(registrationFilePath('coder'))).toBe(true)

    startCalls[0]?.onFatalAuthFailure?.({ brokerToken: 'T1', reason: 'invalid token' })

    await expectStable(() => !existsSync(registrationFilePath('coder')), {
      durationMs: 60,
      description: 'T_new registration deleted by stale T_old fatal callback',
    })
    expect(stopCalls).toEqual([])
    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations).toEqual([{ containerName: 'coder', cwd: '/agent/coder' }])
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

    await waitFor(() => restartCalls.length > 0)
    expect(restartCalls).toEqual([{ containerName: 'coder', cwd: '/agent/coder' }])
  })

  test('boot-time restore tolerates corrupted registration files', async () => {
    const alive = new Set(['good'])
    daemon = await startDaemon({ exec: fakeExec(alive), gcIntervalMs: 1_000_000 })
    await send({ kind: 'register', containerName: 'good', cwd: '/agent/good' })
    await daemon.stop()

    await writeFile(join(registrationsDir(), 'broken.json'), '{ this is not json')
    await writeFile(join(registrationsDir(), 'mismatch.json'), JSON.stringify({ containerName: 'other', cwd: '/x' }))

    daemon = await startDaemon({ exec: fakeExec(alive), gcIntervalMs: 1_000_000 })

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations.map((r) => r.containerName).sort()).toEqual(['good'])
  })

  test('boot-time restore revives portbroker for persisted registrations whose container is still alive', async () => {
    const startCalls: PortbrokerStartInput[] = []
    const portbroker: PortbrokerCallbacks = {
      start: async (input) => {
        startCalls.push(input)
      },
      stop: async () => {},
      forwardedPorts: () => [],
    }
    const alive = new Set(['with-broker'])

    const d1 = await startDaemon({ exec: fakeExec(alive), gcIntervalMs: 1_000_000, portbroker })
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
    daemon = await startDaemon({ exec: fakeExec(alive), gcIntervalMs: 1_000_000, portbroker })

    expect(startCalls).toHaveLength(1)
    expect(startCalls[0]?.containerName).toBe('with-broker')
    expect(startCalls[0]?.cwd).toBe('/agent/with-broker')
    expect(startCalls[0]?.wsHostPort).toBe(54321)
    expect(startCalls[0]?.brokerToken).toBe('btok')
  })

  test('boot-time restore skips persisted registrations whose container is gone, and unlinks the leftover file', async () => {
    const startCalls: PortbrokerStartInput[] = []
    const portbroker: PortbrokerCallbacks = {
      start: async (input) => {
        startCalls.push(input)
      },
      stop: async () => {},
      forwardedPorts: () => [],
    }

    const d1 = await startDaemon({
      exec: fakeExec(new Set(['ghost'])),
      gcIntervalMs: 1_000_000,
      portbroker,
    })
    await send({
      kind: 'register',
      containerName: 'ghost',
      cwd: '/agent/ghost',
      restartToken: 't',
      wsHostPort: 54321,
      portForward: { allow: '*' },
      brokerToken: 'btok-old',
    })
    await d1.stop()

    const filePath = registrationFilePath('ghost')
    expect(existsSync(filePath)).toBe(true)

    startCalls.length = 0
    daemon = await startDaemon({ exec: fakeExec(new Set()), gcIntervalMs: 1_000_000, portbroker })

    expect(startCalls).toHaveLength(0)
    expect(existsSync(filePath)).toBe(false)

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).registrations).toEqual([])
  })

  test('boot-time restore tolerates docker probe failures: unknown status still applies the registration', async () => {
    const startCalls: PortbrokerStartInput[] = []
    const portbroker: PortbrokerCallbacks = {
      start: async (input) => {
        startCalls.push(input)
      },
      stop: async () => {},
      forwardedPorts: () => [],
    }
    const flakyExec: DockerExec = async (args) => {
      if (args[0] === 'ps') return { exitCode: 1, stdout: '', stderr: 'docker daemon hiccup' }
      return { exitCode: 1, stdout: '', stderr: 'unknown command' }
    }

    const d1 = await startDaemon({ exec: fakeExec(new Set(['flaky'])), gcIntervalMs: 1_000_000, portbroker })
    await send({
      kind: 'register',
      containerName: 'flaky',
      cwd: '/agent/flaky',
      restartToken: 't',
      wsHostPort: 54321,
      portForward: { allow: '*' },
      brokerToken: 'btok',
    })
    await d1.stop()

    startCalls.length = 0
    daemon = await startDaemon({ exec: flakyExec, gcIntervalMs: 1_000_000, portbroker })

    expect(startCalls).toHaveLength(1)
    expect(existsSync(registrationFilePath('flaky'))).toBe(true)
  })

  test('register invokes kakaoRenewal.start with the registered container and cwd', async () => {
    const starts: KakaoRenewalStartInput[] = []
    const kakaoRenewal: KakaoRenewalCallbacks = {
      start: (input) => {
        starts.push(input)
      },
      stop: async () => {},
      drain: async () => {},
    }
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, kakaoRenewal })

    await send({ kind: 'register', containerName: 'kakao-agent', cwd: '/agent/kakao' })

    expect(starts).toEqual([{ containerName: 'kakao-agent', cwd: '/agent/kakao' }])
  })

  test('deregister awaits kakaoRenewal.stop for that container', async () => {
    const stopCalls: string[] = []
    const kakaoRenewal: KakaoRenewalCallbacks = {
      start: () => {},
      stop: async (name) => {
        stopCalls.push(name)
      },
      drain: async () => {},
    }
    daemon = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, kakaoRenewal })

    await send({ kind: 'register', containerName: 'kakao-agent', cwd: '/agent/kakao' })
    await send({ kind: 'deregister', containerName: 'kakao-agent' })

    expect(stopCalls).toEqual(['kakao-agent'])
  })

  test('daemon.stop() drains kakaoRenewal across all registered containers', async () => {
    const stopCalls: string[] = []
    const kakaoRenewal: KakaoRenewalCallbacks = {
      start: () => {},
      stop: async (name) => {
        stopCalls.push(name)
      },
      drain: async () => {},
    }
    const d = await startDaemon({ exec: fakeExec(), gcIntervalMs: 1_000_000, kakaoRenewal })

    await send({ kind: 'register', containerName: 'a', cwd: '/agent/a' })
    await send({ kind: 'register', containerName: 'b', cwd: '/agent/b' })
    await d.stop()

    expect(stopCalls.sort()).toEqual(['a', 'b'])
  })

  test('boot-time restore invokes kakaoRenewal.start for persisted registrations whose container is still alive', async () => {
    const starts: KakaoRenewalStartInput[] = []
    const kakaoRenewal: KakaoRenewalCallbacks = {
      start: (input) => {
        starts.push(input)
      },
      stop: async () => {},
      drain: async () => {},
    }
    const alive = new Set(['persistent-kakao'])

    const d1 = await startDaemon({ exec: fakeExec(alive), gcIntervalMs: 1_000_000, kakaoRenewal })
    await send({ kind: 'register', containerName: 'persistent-kakao', cwd: '/agent/pk', restartToken: 't' })
    await d1.stop()

    starts.length = 0
    daemon = await startDaemon({ exec: fakeExec(alive), gcIntervalMs: 1_000_000, kakaoRenewal })

    expect(starts).toEqual([{ containerName: 'persistent-kakao', cwd: '/agent/pk' }])
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
