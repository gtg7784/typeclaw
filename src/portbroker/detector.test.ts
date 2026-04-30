import { describe, expect, test } from 'bun:test'

import type { DockerExec, DockerExecResult } from '@/container'

import { parseListeningPorts, startDetector, type PortChange } from './detector'

const PROC_TCP_TWO_LISTEN = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 100 1 0 100 0
   1: 0000000000000000FFFF00000100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 200 1 0 200 0
   2: 0100007F:0BB8 0100007F:1234 06 00000000:00000000 00:00000000 00000000     0        0 300 1 0 300 0
`
const PROC_TCP_ONE_LISTEN = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 100 1 0 100 0
`
const PROC_TCP_EMPTY = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
`

function fakeExec(scripted: Array<DockerExecResult | Error>): {
  exec: DockerExec
  callCount: () => number
  remaining: () => number
} {
  const queue = [...scripted]
  let callCount = 0
  let last: DockerExecResult | Error | null = null
  const exec: DockerExec = async () => {
    callCount += 1
    const next = queue.shift() ?? last
    if (!next) return { exitCode: 0, stdout: PROC_TCP_EMPTY, stderr: '' }
    last = next
    if (next instanceof Error) throw next
    return next
  }
  return { exec, callCount: () => callCount, remaining: () => queue.length }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('parseListeningPorts', () => {
  test('returns IPv4 LISTEN ports decoded from hex', () => {
    expect(parseListeningPorts(PROC_TCP_ONE_LISTEN)).toEqual(new Set([8080]))
  })

  test('returns IPv4 and IPv6 LISTEN ports together, ignores ESTABLISHED', () => {
    expect(parseListeningPorts(PROC_TCP_TWO_LISTEN)).toEqual(new Set([8080, 80]))
  })

  test('empty content yields empty set', () => {
    expect(parseListeningPorts(PROC_TCP_EMPTY)).toEqual(new Set())
  })

  test('malformed lines are skipped silently', () => {
    expect(parseListeningPorts('garbage\n   sl: nope\n')).toEqual(new Set())
  })
})

describe('startDetector', () => {
  test('emits open events for each new listening port', async () => {
    const events: PortChange[] = []
    const { exec } = fakeExec([{ exitCode: 0, stdout: PROC_TCP_TWO_LISTEN, stderr: '' }])
    const detector = startDetector({
      containerName: 'coder',
      exec,
      intervalMs: 50,
      onChange: (c) => events.push(c),
    })
    await waitFor(() => events.length >= 2)
    await detector.stop()

    const ports = events
      .filter((e) => e.kind === 'open')
      .map((e) => e.port)
      .sort()
    expect(ports).toEqual([80, 8080])
    expect(events.every((e) => e.kind === 'open')).toBe(true)
  })

  test('emits close events when ports disappear', async () => {
    const events: PortChange[] = []
    const { exec } = fakeExec([
      { exitCode: 0, stdout: PROC_TCP_TWO_LISTEN, stderr: '' },
      { exitCode: 0, stdout: PROC_TCP_ONE_LISTEN, stderr: '' },
    ])
    const detector = startDetector({
      containerName: 'coder',
      exec,
      intervalMs: 50,
      onChange: (c) => events.push(c),
    })
    await waitFor(() => events.some((e) => e.kind === 'close'))
    await detector.stop()

    const opens = events
      .filter((e) => e.kind === 'open')
      .map((e) => e.port)
      .sort()
    const closes = events.filter((e) => e.kind === 'close').map((e) => e.port)
    expect(opens).toEqual([80, 8080])
    expect(closes).toEqual([80])
  })

  test('idempotent on stable port set: zero events after the initial scan', async () => {
    const events: PortChange[] = []
    const { exec } = fakeExec([
      { exitCode: 0, stdout: PROC_TCP_ONE_LISTEN, stderr: '' },
      { exitCode: 0, stdout: PROC_TCP_ONE_LISTEN, stderr: '' },
      { exitCode: 0, stdout: PROC_TCP_ONE_LISTEN, stderr: '' },
    ])
    const detector = startDetector({
      containerName: 'coder',
      exec,
      intervalMs: 30,
      onChange: (c) => events.push(c),
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await detector.stop()

    const opens = events.filter((e) => e.kind === 'open')
    const closes = events.filter((e) => e.kind === 'close')
    expect(opens).toHaveLength(1)
    expect(opens[0]!.port).toBe(8080)
    expect(closes).toHaveLength(0)
  })

  test('reports transient exec failures via onError but keeps polling', async () => {
    const events: PortChange[] = []
    const errors: Error[] = []
    const fatals: Error[] = []
    const { exec } = fakeExec([
      { exitCode: 1, stdout: '', stderr: 'transient' },
      { exitCode: 0, stdout: PROC_TCP_ONE_LISTEN, stderr: '' },
    ])
    const detector = startDetector({
      containerName: 'coder',
      exec,
      intervalMs: 30,
      maxConsecutiveFailures: 5,
      onChange: (c) => events.push(c),
      onError: (e) => errors.push(e),
      onFatal: (e) => fatals.push(e),
    })
    await waitFor(() => events.length >= 1)
    await detector.stop()

    expect(events).toEqual([{ kind: 'open', port: 8080 }])
    expect(errors[0]!.message).toContain('transient')
    expect(fatals).toHaveLength(0)
  })

  test('thrown exec errors are reported via onError, not propagated', async () => {
    const errors: Error[] = []
    const { exec } = fakeExec([new Error('connection reset')])
    const detector = startDetector({
      containerName: 'coder',
      exec,
      intervalMs: 30,
      maxConsecutiveFailures: 5,
      onChange: () => {},
      onError: (e) => errors.push(e),
    })
    await waitFor(() => errors.length >= 1)
    await detector.stop()

    expect(errors[0]!.message).toContain('connection reset')
  })

  test('escalates to onFatal after maxConsecutiveFailures', async () => {
    const errors: Error[] = []
    const fatals: Error[] = []
    const { exec } = fakeExec([
      { exitCode: 1, stdout: '', stderr: 'down' },
      { exitCode: 1, stdout: '', stderr: 'down' },
      { exitCode: 1, stdout: '', stderr: 'down' },
    ])
    const detector = startDetector({
      containerName: 'coder',
      exec,
      intervalMs: 30,
      maxConsecutiveFailures: 3,
      onChange: () => {},
      onError: (e) => errors.push(e),
      onFatal: (e) => fatals.push(e),
    })
    await waitFor(() => fatals.length >= 1)
    await detector.stop()

    expect(fatals[0]!.message).toContain('docker exec failed')
    expect(fatals[0]!.message).toContain('3 times')
  })

  test('stop() halts further ticks', async () => {
    const events: PortChange[] = []
    const { exec, callCount } = fakeExec(
      Array.from({ length: 100 }, () => ({ exitCode: 0, stdout: PROC_TCP_ONE_LISTEN, stderr: '' })),
    )
    const detector = startDetector({
      containerName: 'coder',
      exec,
      intervalMs: 30,
      onChange: (c) => events.push(c),
    })
    await waitFor(() => events.length >= 1)
    await detector.stop()
    const at = callCount()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(callCount()).toBe(at)
  })
})
