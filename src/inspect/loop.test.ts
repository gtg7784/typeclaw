import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runInspectLoop } from './loop'
import type { InspectEvent } from './types'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-inspect-loop-'))
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

async function seedSession(basename: string, lines: string[], mtimeSeconds: number): Promise<void> {
  const path = join(agentDir, 'sessions', basename)
  await writeFile(path, lines.join('\n') + '\n')
  await utimes(path, mtimeSeconds, mtimeSeconds)
}

function metaLine(origin: unknown): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'typeclaw.session-meta',
    data: { origin },
    timestamp: 1_000_000,
  })
}

function userLine(text: string, timestamp = 1_000_001): string {
  return JSON.stringify({ type: 'message', message: { role: 'user', content: text, timestamp } })
}

function captureSink(): {
  out: string[]
  err: string[]
  push: { stdout: (l: string) => void; stderr: (l: string) => void }
} {
  const out: string[] = []
  const err: string[] = []
  return { out, err, push: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) } }
}

const ID_LOOP_A = '019ee000-aaaa-7000-9000-00000000aaaa'
const ID_LOOP_B = '019ee000-bbbb-7000-9000-00000000bbbb'
const ID_LOOP_C = '019ee000-cccc-7000-9000-00000000cccc'
const ID_LOOP_D = '019ee000-dddd-7000-9000-00000000dddd'

describe('runInspectLoop', () => {
  test('esc during live tail returns to picker; picker selects another session; second stream renders', async () => {
    await seedSession(`a_${ID_LOOP_A}.jsonl`, [metaLine({ kind: 'tui' }), userLine('first')], 1000)
    await seedSession(`b_${ID_LOOP_B}.jsonl`, [metaLine({ kind: 'tui' }), userLine('second')], 2000)
    const sink = captureSink()

    let escController: AbortController | null = null
    let liveCallCount = 0

    async function* awaitableLive(signal: AbortSignal | undefined): AsyncGenerator<InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'hello' } }
      await new Promise<void>((resolve) => {
        if (signal === undefined || signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    async function* finiteLive(): AsyncGenerator<InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'second-stream' } }
    }

    let pickerCalls = 0
    const result = await runInspectLoop({
      agentDir,
      sessionIdOrPrefix: ID_LOOP_A,
      color: false,
      selectSession: async (sessions) => {
        pickerCalls++
        return sessions.find((s) => s.sessionId === ID_LOOP_B) ?? null
      },
      liveSource: (o) => {
        liveCallCount++
        if (liveCallCount === 1) {
          queueMicrotask(() => escController?.abort())
          return awaitableLive(o.signal)
        }
        return finiteLive()
      },
      newEscSignal: () => {
        escController = new AbortController()
        return escController.signal
      },
      ...sink.push,
    })

    expect(result.ok).toBe(true)
    expect(pickerCalls).toBe(1)
    expect(liveCallCount).toBe(2)
    expect(sink.out.some((l) => l.includes(ID_LOOP_A.slice(0, 12)))).toBe(true)
    expect(sink.out.some((l) => l.includes(ID_LOOP_B.slice(0, 12)))).toBe(true)
  })

  test('picker cancel after esc returns ok with exit 130 (picker null is final)', async () => {
    await seedSession(`a_${ID_LOOP_C}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const sink = captureSink()
    let escController: AbortController | null = null

    async function* awaitableLive(signal: AbortSignal | undefined): AsyncGenerator<InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'ev' } }
      await new Promise<void>((resolve) => {
        if (signal === undefined || signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }

    const result = await runInspectLoop({
      agentDir,
      sessionIdOrPrefix: ID_LOOP_C,
      color: false,
      selectSession: async () => null,
      liveSource: (o) => {
        queueMicrotask(() => escController?.abort())
        return awaitableLive(o.signal)
      },
      newEscSignal: () => {
        escController = new AbortController()
        return escController.signal
      },
      ...sink.push,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(130)
  })

  test('without esc abort, runs once and returns ok (no loop)', async () => {
    await seedSession(`a_${ID_LOOP_D}.jsonl`, [metaLine({ kind: 'tui' }), userLine('hi')], 1000)
    const sink = captureSink()
    let liveCallCount = 0

    async function* fakeLive(): AsyncGenerator<InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'one' } }
    }

    const result = await runInspectLoop({
      agentDir,
      sessionIdOrPrefix: ID_LOOP_D,
      color: false,
      selectSession: async () => null,
      liveSource: () => {
        liveCallCount++
        return fakeLive()
      },
      newEscSignal: () => new AbortController().signal,
      ...sink.push,
    })

    expect(result.ok).toBe(true)
    expect(liveCallCount).toBe(1)
  })

  test('liveHint renders after the live divider but only when live source yields', async () => {
    await seedSession(`a_${ID_LOOP_D}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const sink = captureSink()
    async function* fakeLive(): AsyncGenerator<InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'tick' } }
    }

    const result = await runInspectLoop({
      agentDir,
      sessionIdOrPrefix: ID_LOOP_D,
      color: false,
      selectSession: async () => null,
      liveSource: (o) => {
        o.onSubscribed?.(true)
        return fakeLive()
      },
      newEscSignal: () => new AbortController().signal,
      liveHint: '(press esc to return to session list)',
      ...sink.push,
    })

    expect(result.ok).toBe(true)
    const dividerIdx = sink.out.findIndex((l) => l.includes('─── live ───'))
    const hintIdx = sink.out.findIndex((l) => l.includes('press esc to return to session list'))
    expect(dividerIdx).toBeGreaterThanOrEqual(0)
    expect(hintIdx).toBe(dividerIdx + 1)
  })

  test('picker re-opened via esc receives previously-selected sessionId as initialSessionId', async () => {
    await seedSession(`a_${ID_LOOP_A}.jsonl`, [metaLine({ kind: 'tui' }), userLine('first')], 1000)
    await seedSession(`b_${ID_LOOP_B}.jsonl`, [metaLine({ kind: 'tui' }), userLine('second')], 2000)
    await seedSession(`c_${ID_LOOP_C}.jsonl`, [metaLine({ kind: 'tui' }), userLine('third')], 3000)
    const sink = captureSink()

    let escController: AbortController | null = null
    let liveCallCount = 0
    const pickerHints: (string | undefined)[] = []

    async function* awaitableLive(signal: AbortSignal | undefined): AsyncGenerator<InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'hello' } }
      await new Promise<void>((resolve) => {
        if (signal === undefined || signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    async function* finiteLive(): AsyncGenerator<InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'final' } }
    }

    let pickerCalls = 0
    const result = await runInspectLoop({
      agentDir,
      color: false,
      selectSession: async (sessions, selectOpts) => {
        pickerCalls++
        pickerHints.push(selectOpts?.initialSessionId)
        if (pickerCalls === 1) {
          return sessions.find((s) => s.sessionId === ID_LOOP_A) ?? null
        }
        return sessions.find((s) => s.sessionId === ID_LOOP_C) ?? null
      },
      liveSource: (o) => {
        liveCallCount++
        if (liveCallCount === 1) {
          queueMicrotask(() => escController?.abort())
          return awaitableLive(o.signal)
        }
        return finiteLive()
      },
      newEscSignal: () => {
        escController = new AbortController()
        return escController.signal
      },
      ...sink.push,
    })

    expect(result.ok).toBe(true)
    expect(pickerCalls).toBe(2)
    expect(pickerHints[0]).toBeUndefined()
    expect(pickerHints[1]).toBe(ID_LOOP_A)
  })
})
