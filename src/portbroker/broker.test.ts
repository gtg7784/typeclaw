import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { DockerExec } from '@/container'

import { startBroker, type BrokerLogEvent, defaultResolveIp, type ForwarderFactory } from './broker'
import type { Forwarder, ForwarderOptions, ForwarderStartResult } from './forwarder'

const PROC_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'

function procWithPorts(ports: number[]): string {
  const lines = ports.map(
    (port, i) =>
      `   ${i}: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 100 1 0 100 0`,
  )
  return PROC_HEADER + lines.join('\n') + '\n'
}

function fakeForwarderFactory(): {
  factory: ForwarderFactory
  active: () => Map<number, ForwarderOptions>
  failNext: (reason: string) => void
  history: () => ForwarderOptions[]
} {
  const open = new Map<number, ForwarderOptions>()
  const history: ForwarderOptions[] = []
  let failure: string | null = null
  const factory: ForwarderFactory = async (options: ForwarderOptions): Promise<ForwarderStartResult> => {
    history.push(options)
    if (failure !== null) {
      const reason = failure
      failure = null
      return { ok: false, reason }
    }
    const forwarder: Forwarder = {
      hostPort: options.hostPort,
      upstreamHost: options.upstreamHost,
      upstreamPort: options.upstreamPort,
      stop: async () => {
        open.delete(options.hostPort)
      },
    }
    open.set(options.hostPort, options)
    return { ok: true, forwarder }
  }
  return {
    factory,
    active: () => open,
    failNext: (reason: string) => {
      failure = reason
    },
    history: () => history,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let events: BrokerLogEvent[]

beforeEach(() => {
  events = []
})

afterEach(() => {
  events = []
})

describe('defaultResolveIp', () => {
  test('parses JSON inspect output and returns IP from a sorted-stable network', async () => {
    const exec: DockerExec = async () => ({
      exitCode: 0,
      stdout: '{"frontend":{"IPAddress":"10.0.1.4"},"backend":{"IPAddress":"10.0.2.5"}}',
      stderr: '',
    })
    expect(await defaultResolveIp('coder', exec)).toBe('10.0.2.5')
  })

  test('prefers a named network over the default `bridge`', async () => {
    const exec: DockerExec = async () => ({
      exitCode: 0,
      stdout: '{"bridge":{"IPAddress":"172.17.0.4"},"typeclaw":{"IPAddress":"10.0.5.7"}}',
      stderr: '',
    })
    expect(await defaultResolveIp('coder', exec)).toBe('10.0.5.7')
  })

  test('falls back to bridge when it is the only network', async () => {
    const exec: DockerExec = async () => ({
      exitCode: 0,
      stdout: '{"bridge":{"IPAddress":"172.17.0.4"}}',
      stderr: '',
    })
    expect(await defaultResolveIp('coder', exec)).toBe('172.17.0.4')
  })

  test('returns null on non-zero exit', async () => {
    const exec: DockerExec = async () => ({ exitCode: 1, stdout: '', stderr: 'no such container' })
    expect(await defaultResolveIp('coder', exec)).toBeNull()
  })

  test('returns null on malformed JSON', async () => {
    const exec: DockerExec = async () => ({ exitCode: 0, stdout: '{not json', stderr: '' })
    expect(await defaultResolveIp('coder', exec)).toBeNull()
  })
})

describe('startBroker', () => {
  test('spawns a forwarder for each new listening port via the injected factory', async () => {
    const { factory, active } = fakeForwarderFactory()
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }
      return { exitCode: 0, stdout: procWithPorts([3000, 5173]), stderr: '' }
    }

    const result = await startBroker({
      containerName: 'coder',
      excludePorts: new Set([8973]),
      exec,
      intervalMs: 30,
      forwarderFactory: factory,
      onLog: (e) => events.push(e),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      await waitFor(() => active().size === 2)
      const opts3000 = active().get(3000)
      expect(opts3000?.upstreamHost).toBe('10.0.0.5')
      expect(opts3000?.upstreamPort).toBe(3000)
      expect(active().get(5173)?.upstreamPort).toBe(5173)
    } finally {
      await result.broker.stop()
    }
  })

  test('skips ports listed in excludePorts', async () => {
    const { factory, active } = fakeForwarderFactory()
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }
      return { exitCode: 0, stdout: procWithPorts([3000, 8973]), stderr: '' }
    }

    const result = await startBroker({
      containerName: 'coder',
      excludePorts: new Set([8973]),
      exec,
      intervalMs: 30,
      forwarderFactory: factory,
      onLog: (e) => events.push(e),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      await waitFor(() => events.some((e) => e.kind === 'skip-excluded' && e.port === 8973))
      await waitFor(() => active().has(3000))
      expect(active().has(8973)).toBe(false)
    } finally {
      await result.broker.stop()
    }
  })

  test('removes the forwarder when its port disappears from the container', async () => {
    const { factory, active } = fakeForwarderFactory()
    let phase = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }
      const ports = phase === 0 ? [3000] : []
      phase += 1
      return { exitCode: 0, stdout: procWithPorts(ports), stderr: '' }
    }

    const result = await startBroker({
      containerName: 'coder',
      excludePorts: new Set([8973]),
      exec,
      intervalMs: 30,
      forwarderFactory: factory,
      onLog: (e) => events.push(e),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      await waitFor(() => active().has(3000))
      await waitFor(() => !active().has(3000))
      const closes = events.filter((e) => e.kind === 'close')
      expect(closes).toHaveLength(1)
    } finally {
      await result.broker.stop()
    }
  })

  test('returns failure when container IP cannot be resolved', async () => {
    const exec: DockerExec = async () => ({ exitCode: 1, stdout: '', stderr: 'no such container' })
    const result = await startBroker({
      containerName: 'ghost',
      excludePorts: new Set(),
      exec,
      intervalMs: 30,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('ghost')
  })

  test('logs skip-eaddrinuse when the forwarder factory reports the host port is busy', async () => {
    const { factory, failNext, active } = fakeForwarderFactory()
    failNext('listen EADDRINUSE 127.0.0.1:3000')

    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }
      return { exitCode: 0, stdout: procWithPorts([3000]), stderr: '' }
    }

    const result = await startBroker({
      containerName: 'coder',
      excludePorts: new Set([8973]),
      exec,
      intervalMs: 30,
      forwarderFactory: factory,
      onLog: (e) => events.push(e),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      await waitFor(() => events.some((e) => e.kind === 'skip-eaddrinuse'))
      expect(active().has(3000)).toBe(false)
    } finally {
      await result.broker.stop()
    }
  })

  test('passes the resolved container IP to the forwarder factory', async () => {
    const { factory, active } = fakeForwarderFactory()
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '{"bridge":{"IPAddress":"172.17.0.4"}}', stderr: '' }
      return { exitCode: 0, stdout: procWithPorts([3000]), stderr: '' }
    }

    const result = await startBroker({
      containerName: 'coder',
      excludePorts: new Set([8973]),
      exec,
      intervalMs: 30,
      forwarderFactory: factory,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      await waitFor(() => active().size === 1)
      expect(active().get(3000)?.upstreamHost).toBe('172.17.0.4')
    } finally {
      await result.broker.stop()
    }
  })

  test('serializes change handling: open then immediate close yields a clean state', async () => {
    const { factory, active } = fakeForwarderFactory()
    let tickCount = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '{"bridge":{"IPAddress":"10.0.0.5"}}', stderr: '' }
      tickCount += 1
      const ports = tickCount === 1 ? [3000] : []
      return { exitCode: 0, stdout: procWithPorts(ports), stderr: '' }
    }

    const result = await startBroker({
      containerName: 'coder',
      excludePorts: new Set(),
      exec,
      intervalMs: 10,
      forwarderFactory: factory,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      await waitFor(() => tickCount >= 3)
      expect(active().has(3000)).toBe(false)
    } finally {
      await result.broker.stop()
    }
  })
})
