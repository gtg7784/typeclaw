import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DockerExec } from '@/container'

import { send } from './client'
import { startDaemon, type Daemon } from './daemon'
import type { Forwarder, ForwarderOptions, ForwarderStartResult } from './forwarder'
import type { ListResult } from './protocol'

const PROC_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'

function procWithPorts(ports: number[]): string {
  const lines = ports.map(
    (port, i) =>
      `   ${i}: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 100 1 0 100 0`,
  )
  return PROC_HEADER + lines.join('\n') + '\n'
}

const noopForwarderFactory = async (options: ForwarderOptions): Promise<ForwarderStartResult> => {
  const forwarder: Forwarder = {
    hostPort: options.hostPort,
    upstreamHost: options.upstreamHost,
    upstreamPort: options.upstreamPort,
    stop: async () => {},
  }
  return { ok: true, forwarder }
}

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

function fakeExec(routes: Map<string, { exitCode: number; stdout: string; stderr: string }>): DockerExec {
  return async (args) => {
    if (args[0] === 'inspect') {
      const name = args[args.length - 1]
      if (typeof name !== 'string') return { exitCode: 1, stdout: '', stderr: 'no name' }
      const inspect = routes.get(`inspect:${name}`)
      if (inspect) return inspect
      return { exitCode: 1, stdout: '', stderr: 'no such container' }
    }
    if (args[0] === 'ps') {
      const filter = args.find((a) => a.startsWith('name='))
      if (!filter) return { exitCode: 0, stdout: '', stderr: '' }
      const name = filter.replace(/^name=\^?/, '').replace(/\$$/, '')
      const has = routes.has(`alive:${name}`)
      return { exitCode: 0, stdout: has ? `${name}\n` : '', stderr: '' }
    }
    if (args[0] === 'exec') {
      const name = args[1]
      if (typeof name !== 'string') return { exitCode: 1, stdout: '', stderr: 'no name' }
      const proc = routes.get(`proc:${name}`)
      return proc ?? { exitCode: 1, stdout: '', stderr: 'no proc' }
    }
    return { exitCode: 1, stdout: '', stderr: 'unknown command' }
  }
}

describe('startDaemon', () => {
  test('register starts a broker; list reflects the registered container', async () => {
    const routes = new Map([
      ['inspect:coder', { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }],
      ['proc:coder', { exitCode: 0, stdout: procWithPorts([3000]), stderr: '' }],
      ['alive:coder', { exitCode: 0, stdout: 'coder\n', stderr: '' }],
    ])
    daemon = await startDaemon({
      exec: fakeExec(routes),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 1_000_000,
    })

    const reg = await send({ kind: 'register', containerName: 'coder', cwd: '/tmp/coder' })
    expect(reg.ok).toBe(true)

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    const result = list.result as ListResult
    expect(result.brokers).toHaveLength(1)
    expect(result.brokers[0]?.containerName).toBe('coder')
    expect(result.brokers[0]?.containerIp).toBe('10.0.0.5')
  })

  test('register is idempotent for the same container', async () => {
    const routes = new Map([
      ['inspect:coder', { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }],
      ['proc:coder', { exitCode: 0, stdout: procWithPorts([]), stderr: '' }],
    ])
    daemon = await startDaemon({
      exec: fakeExec(routes),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 1_000_000,
    })
    expect((await send({ kind: 'register', containerName: 'coder', cwd: '/x' })).ok).toBe(true)
    expect((await send({ kind: 'register', containerName: 'coder', cwd: '/x' })).ok).toBe(true)

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).brokers).toHaveLength(1)
  })

  test('deregister stops the broker; list shows it gone', async () => {
    const routes = new Map([
      ['inspect:coder', { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }],
      ['proc:coder', { exitCode: 0, stdout: procWithPorts([]), stderr: '' }],
    ])
    daemon = await startDaemon({
      exec: fakeExec(routes),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 1_000_000,
    })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })
    expect((await send({ kind: 'deregister', containerName: 'coder' })).ok).toBe(true)
    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).brokers).toHaveLength(0)
  })

  test('deregister of unknown container is a no-op (ok)', async () => {
    daemon = await startDaemon({
      exec: fakeExec(new Map()),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 1_000_000,
    })
    expect((await send({ kind: 'deregister', containerName: 'never' })).ok).toBe(true)
  })

  test('register fails cleanly when the container does not exist', async () => {
    daemon = await startDaemon({
      exec: fakeExec(new Map()),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 1_000_000,
    })
    const reg = await send({ kind: 'register', containerName: 'ghost', cwd: '/x' })
    expect(reg.ok).toBe(false)
    if (reg.ok) return
    expect(reg.reason).toContain('ghost')
  })

  test('GC removes brokers whose containers vanished', async () => {
    const routes = new Map([
      ['inspect:coder', { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }],
      ['proc:coder', { exitCode: 0, stdout: procWithPorts([]), stderr: '' }],
      ['alive:coder', { exitCode: 0, stdout: 'coder\n', stderr: '' }],
    ])
    daemon = await startDaemon({
      exec: fakeExec(routes),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 30,
      gcMissesToDeregister: 1,
    })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })
    routes.delete('alive:coder')

    const start = Date.now()
    while (Date.now() - start < 1500) {
      const list = await send({ kind: 'list' })
      if (list.ok && (list.result as ListResult).brokers.length === 0) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error('GC did not remove dead container in time')
  })

  test('GC requires gcMissesToDeregister consecutive absences before tearing a broker down', async () => {
    const routes = new Map([
      ['inspect:coder', { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }],
      ['proc:coder', { exitCode: 0, stdout: procWithPorts([]), stderr: '' }],
      ['alive:coder', { exitCode: 0, stdout: 'coder\n', stderr: '' }],
    ])
    daemon = await startDaemon({
      exec: fakeExec(routes),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 20,
      gcMissesToDeregister: 3,
    })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })

    routes.delete('alive:coder')
    await new Promise((resolve) => setTimeout(resolve, 30))
    routes.set('alive:coder', { exitCode: 0, stdout: 'coder\n', stderr: '' })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).brokers.map((b) => b.containerName)).toContain('coder')
  })

  test('GC tolerates docker exec failures (status=unknown does not count as gone)', async () => {
    let psFails = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') {
        return { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }
      }
      if (args[0] === 'ps') {
        psFails += 1
        return { exitCode: 1, stdout: '', stderr: 'docker daemon hiccup' }
      }
      if (args[0] === 'exec') {
        return { exitCode: 0, stdout: procWithPorts([]), stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unknown' }
    }
    daemon = await startDaemon({
      exec,
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 20,
      gcMissesToDeregister: 1,
    })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x' })

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(psFails).toBeGreaterThan(0)
    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).brokers.map((b) => b.containerName)).toContain('coder')
  })

  test('register passes excludePorts to the broker (skip-excluded log emitted)', async () => {
    const routes = new Map([
      ['inspect:coder', { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }],
      ['proc:coder', { exitCode: 0, stdout: procWithPorts([3000, 8973]), stderr: '' }],
      ['alive:coder', { exitCode: 0, stdout: 'coder\n', stderr: '' }],
    ])
    const events: Array<string> = []
    daemon = await startDaemon({
      exec: fakeExec(routes),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 1_000_000,
      onLog: (e) => {
        if (e.kind === 'skip-excluded') events.push(`skip:${e.port}`)
        if (e.kind === 'open') events.push(`open:${e.hostPort}`)
      },
    })
    await send({ kind: 'register', containerName: 'coder', cwd: '/x', excludePorts: [8973] })

    const start = Date.now()
    while (Date.now() - start < 1500) {
      if (events.includes('skip:8973') && events.includes('open:3000')) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error(`exclude not honored; saw events: ${events.join(',')}`)
  })

  test('register concurrent with deregister is serialized: no broker remains', async () => {
    const routes = new Map([
      ['inspect:coder', { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }],
      ['proc:coder', { exitCode: 0, stdout: procWithPorts([]), stderr: '' }],
      ['alive:coder', { exitCode: 0, stdout: 'coder\n', stderr: '' }],
    ])
    daemon = await startDaemon({
      exec: fakeExec(routes),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 1_000_000,
    })

    const [reg, dereg] = await Promise.all([
      send({ kind: 'register', containerName: 'coder', cwd: '/x' }),
      send({ kind: 'deregister', containerName: 'coder' }),
    ])
    expect(reg.ok).toBe(true)
    expect(dereg.ok).toBe(true)

    const list = await send({ kind: 'list' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.result as ListResult).brokers).toHaveLength(0)
  })

  test('startDaemon refuses to bind when an existing daemon is reachable', async () => {
    const routes = new Map<string, { exitCode: number; stdout: string; stderr: string }>()
    daemon = await startDaemon({
      exec: fakeExec(routes),
      forwarderFactory: noopForwarderFactory,
      gcIntervalMs: 1_000_000,
    })

    await expect(
      startDaemon({
        exec: fakeExec(routes),
        forwarderFactory: noopForwarderFactory,
        gcIntervalMs: 1_000_000,
      }),
    ).rejects.toThrow(/already listening/)
  })
})
