import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeLogTimestampReformatter } from './log-timestamps'
import { buildDockerLogsCmd, parseTailValue, planLogs, pumpWithTimestamps } from './logs'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-logs-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('planLogs', () => {
  test('derives container name from the folder basename and carries follow flag through', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(planLogs(folder, { follow: false })).toEqual({ containerName: 'coder', follow: false })
    expect(planLogs(folder, { follow: true })).toEqual({ containerName: 'coder', follow: true })
  })

  test('carries tail through when supplied; omits the field when undefined', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(planLogs(folder, { follow: false, tail: '50' })).toEqual({
      containerName: 'coder',
      follow: false,
      tail: '50',
    })
    expect(planLogs(folder, { follow: true, tail: 'all' })).toEqual({
      containerName: 'coder',
      follow: true,
      tail: 'all',
    })
    expect(planLogs(folder, { follow: false })).toEqual({ containerName: 'coder', follow: false })
  })
})

describe('parseTailValue', () => {
  test('accepts non-negative integers and returns them verbatim', () => {
    expect(parseTailValue('0')).toEqual({ ok: true, value: '0' })
    expect(parseTailValue('1')).toEqual({ ok: true, value: '1' })
    expect(parseTailValue('100')).toEqual({ ok: true, value: '100' })
    expect(parseTailValue('  42  ')).toEqual({ ok: true, value: '42' })
  })

  test('accepts the "all" sentinel case-insensitively', () => {
    expect(parseTailValue('all')).toEqual({ ok: true, value: 'all' })
    expect(parseTailValue('ALL')).toEqual({ ok: true, value: 'all' })
    expect(parseTailValue(' All ')).toEqual({ ok: true, value: 'all' })
  })

  test('rejects empty, negative, fractional, signed, and garbage inputs', () => {
    expect(parseTailValue('').ok).toBe(false)
    expect(parseTailValue('   ').ok).toBe(false)
    expect(parseTailValue('-5').ok).toBe(false)
    expect(parseTailValue('+5').ok).toBe(false)
    expect(parseTailValue('3.5').ok).toBe(false)
    expect(parseTailValue('1e2').ok).toBe(false)
    expect(parseTailValue('007').ok).toBe(false)
    expect(parseTailValue('ten').ok).toBe(false)
  })
})

describe('buildDockerLogsCmd', () => {
  test('builds the base argv when follow is false', () => {
    expect(buildDockerLogsCmd({ containerName: 'coder', follow: false })).toEqual([
      'docker',
      'logs',
      '--timestamps',
      'coder',
    ])
  })

  test('appends -f before the container name when follow is true', () => {
    expect(buildDockerLogsCmd({ containerName: 'coder', follow: true })).toEqual([
      'docker',
      'logs',
      '--timestamps',
      '-f',
      'coder',
    ])
  })

  test('omits --tail when the field is absent so docker uses its default ("all")', () => {
    expect(buildDockerLogsCmd({ containerName: 'coder', follow: false })).not.toContain('--tail')
  })

  test('inserts --tail <value> before -f when both are set', () => {
    expect(buildDockerLogsCmd({ containerName: 'coder', follow: true, tail: '50' })).toEqual([
      'docker',
      'logs',
      '--timestamps',
      '--tail',
      '50',
      '-f',
      'coder',
    ])
  })

  test('passes the "all" sentinel through unchanged', () => {
    expect(buildDockerLogsCmd({ containerName: 'coder', follow: false, tail: 'all' })).toEqual([
      'docker',
      'logs',
      '--timestamps',
      '--tail',
      'all',
      'coder',
    ])
  })
})

describe('pumpWithTimestamps', () => {
  test('reformats Docker --timestamps output and writes complete lines to the sink', async () => {
    // given a stream emitting two timestamped lines split across chunks
    const FIXED = new Date('2026-05-13T14:23:01Z')
    const expectedStamp = formatLocal(FIXED)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode('2026-05-13T14:23:01Z hel'))
        controller.enqueue(enc.encode('lo\n2026-05-13T14:23:01Z second\n'))
        controller.close()
      },
    })
    const chunks: string[] = []
    const sink = { write: (s: string): boolean => (chunks.push(s), true) } as unknown as NodeJS.WritableStream

    // when pumped through the timestamp reformatter
    await pumpWithTimestamps(
      stream,
      sink,
      makeLogTimestampReformatter(() => FIXED),
    )

    // then the sink sees both lines reformatted to local YYYY-MM-DD HH:MM:SS
    expect(chunks.join('')).toBe(`${expectedStamp} hello\n${expectedStamp} second\n`)
  })

  test('flushes a partial trailing line when the stream closes mid-line', async () => {
    const FIXED = new Date('2026-05-13T14:23:01Z')
    const expectedStamp = formatLocal(FIXED)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('2026-05-13T14:23:01Z partial'))
        controller.close()
      },
    })
    const chunks: string[] = []
    const sink = { write: (s: string): boolean => (chunks.push(s), true) } as unknown as NodeJS.WritableStream

    await pumpWithTimestamps(
      stream,
      sink,
      makeLogTimestampReformatter(() => FIXED),
    )

    expect(chunks.join('')).toBe(`${expectedStamp} partial\n`)
  })

  test('resolves when the signal aborts mid-read on a never-ending stream (the esc-in-logs freeze)', async () => {
    // A `docker logs -f` stream that never emits or closes: without abort-aware
    // reading, pumpWithTimestamps would hang forever and esc could not escape.
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const sink = { write: (): boolean => true } as unknown as NodeJS.WritableStream
    const ctrl = new AbortController()

    const pump = pumpWithTimestamps(stream, sink, makeLogTimestampReformatter(), ctrl.signal)
    queueMicrotask(() => ctrl.abort())

    // then it resolves (does not hang) and the reader was cancelled
    await pump
    expect(cancelled).toBe(true)
  })

  test('returns immediately when the signal is already aborted', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const sink = { write: (): boolean => true } as unknown as NodeJS.WritableStream
    const ctrl = new AbortController()
    ctrl.abort()

    await pumpWithTimestamps(stream, sink, makeLogTimestampReformatter(), ctrl.signal)
    expect(cancelled).toBe(true)
  })
})

function formatLocal(d: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
