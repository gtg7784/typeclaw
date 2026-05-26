import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeLogTimestampReformatter } from './log-timestamps'
import { buildDockerLogsCmd, planLogs, pumpWithTimestamps } from './logs'

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
})

function formatLocal(d: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
