import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runInspect } from './index'
import type { SessionSummary } from './session-list'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-inspect-run-'))
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

function assistantLine(text: string, timestamp = 1_000_002): string {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      provider: 'fake',
      model: 'fake-model',
      stopReason: 'end_turn',
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.0001 } },
      timestamp,
    },
  })
}

function captureSink(): {
  out: string[]
  err: string[]
  push: { stdout: (l: string) => void; stderr: (l: string) => void }
} {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    push: {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    },
  }
}

const neverPick = async (_: SessionSummary[]): Promise<SessionSummary | null> => null

const ID_ABC = '019dda40-aaaa-7000-9000-00000000aaaa'
const ID_JSONOUT = '019dda40-bbbb-7000-9000-00000000bbbb'
const ID_FILT = '019dda40-cccc-7000-9000-00000000cccc'
const ID_SINCE = '019dda40-dddd-7000-9000-00000000dddd'
const ID_LIVET = '019dda40-eeee-7000-9000-00000000eeee'
const ID_DEAD = '019dda40-ffff-7000-9000-00000000ffff'
const ID_ERR = '019dda40-1111-7000-9000-000000001111'
const ID_NO_LIVE = '019dda40-2222-7000-9000-000000002222'
const ID_PICK1 = '019dda40-3333-7000-9000-000000003333'
const ID_PICK2 = '019dda40-4444-7000-9000-000000004444'
const ID_AMB_1 = '019dda40-5555-7000-9000-000000000001'
const ID_AMB_2 = '019dda40-5555-7000-9000-000000000002'
const AMB_PREFIX = '019dda40-5555'

describe('runInspect — direct session id (replay-then-exit)', () => {
  test('replays meta, user, assistant, done in order; returns ok', async () => {
    await seedSession(
      `2026-05-22T00-00-00-000Z_${ID_ABC}.jsonl`,
      [metaLine({ kind: 'tui' }), userLine('hi'), assistantLine('hello')],
      1000,
    )
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_ABC,
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const stripTime = (l: string) => l.replace(/\d{2}:\d{2}:\d{2}/, 'HH:MM:SS')
    const cats = sink.out.slice(1, -1).map((l) => stripTime(l).split('  ')[1]?.trim())
    expect(cats).toEqual(['meta', 'user', 'assist', 'done'])
    expect(sink.out[0]!).toContain(ID_ABC.slice(0, 12))
    expect(sink.out[0]!).toContain('TUI')
    expect(sink.out.at(-1)!).toContain('end of transcript')
  })

  test('--json emits one event per line and omits the header/footer', async () => {
    await seedSession(`a_${ID_JSONOUT}.jsonl`, [metaLine({ kind: 'tui' }), userLine('hi')], 1000)
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_JSONOUT,
      json: true,
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    expect(sink.out.every((l) => l.startsWith('{'))).toBe(true)
    for (const line of sink.out) {
      const parsed = JSON.parse(line)
      expect(parsed.sessionId).toBe(ID_JSONOUT)
      expect(typeof parsed.cat).toBe('string')
    }
  })

  test('filter narrows which events render', async () => {
    await seedSession(
      `a_${ID_FILT}.jsonl`,
      [metaLine({ kind: 'tui' }), userLine('a'), userLine('b'), assistantLine('hello')],
      1000,
    )
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_FILT,
      filter: 'user',
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    const events = sink.out.slice(1, -1)
    expect(events).toHaveLength(2)
    for (const ev of events) expect(ev).toMatch(/user\s+/)
  })

  test('--since filters out older events by their timestamp', async () => {
    await seedSession(
      `a_${ID_SINCE}.jsonl`,
      [metaLine({ kind: 'tui' }), userLine('old', Date.now() - 86_400_000), userLine('new', Date.now())],
      1000,
    )
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_SINCE,
      since: '1h',
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    const events = sink.out.slice(1, -1)
    const userBodies = events.filter((l) => l.includes('user')).map((l) => l.trim())
    expect(userBodies.length).toBe(1)
    expect(userBodies[0]!.endsWith('new')).toBe(true)
  })

  test('invalid filter spec returns exit 2 with a precise reason', async () => {
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_ABC,
      filter: 'wat',
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(2)
    expect(result.reason).toContain('"wat"')
  })

  test('invalid duration spec returns exit 2', async () => {
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_ABC,
      since: 'forever',
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(2)
  })

  test('session not found returns exit 1', async () => {
    const sink = captureSink()
    const ghostId = '019dda40-dead-7000-9000-000000000000'
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ghostId,
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(1)
    expect(result.reason).toContain(ghostId)
  })

  test('ambiguous prefix returns exit 2 with all matches listed', async () => {
    await seedSession(`a_${ID_AMB_1}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    await seedSession(`b_${ID_AMB_2}.jsonl`, [metaLine({ kind: 'tui' })], 2000)
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: AMB_PREFIX,
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(2)
    expect(result.reason).toContain(ID_AMB_1)
    expect(result.reason).toContain(ID_AMB_2)
  })
})

describe('runInspect — live tail (when liveSource is provided)', () => {
  test('replays JSONL then prints the live divider, then yields live events', async () => {
    await seedSession(`a_${ID_LIVET}.jsonl`, [metaLine({ kind: 'tui' }), userLine('hi')], 1000)
    const sink = captureSink()

    async function* fakeLive(): AsyncGenerator<import('./types').InspectEvent> {
      yield { cat: 'tool', ts: Date.now(), phase: 'start', toolCallId: 'c1', name: 'read' }
      yield {
        cat: 'tool',
        ts: Date.now(),
        phase: 'end',
        toolCallId: 'c1',
        name: 'read',
        result: 'ok',
        isError: false,
        durationMs: 10,
      }
    }

    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_LIVET,
      color: false,
      selectSession: neverPick,
      liveSource: (o) => {
        o.onSubscribed?.(true)
        return fakeLive()
      },
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    const stripTime = (l: string) => l.replace(/\d{2}:\d{2}:\d{2}/, 'HH:MM:SS')
    const tags = sink.out.slice(1, -1).map((l) => stripTime(l).split('  ')[1]?.trim())
    expect(tags).toEqual(['meta', 'user', undefined, 'tool ▸', 'tool ◂'])
    expect(sink.out.find((l) => l.includes('─── live ───'))).toBeDefined()
    expect(sink.out.at(-1)!).toContain('end of transcript')
  })

  test('reports "session not in registry" divider when liveSource onSubscribed says sessionLive=false', async () => {
    await seedSession(`a_${ID_DEAD}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const sink = captureSink()
    async function* fakeLive(): AsyncGenerator<import('./types').InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'cron-fired' } }
    }
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_DEAD,
      color: false,
      selectSession: neverPick,
      liveSource: (o) => {
        o.onSubscribed?.(false)
        return fakeLive()
      },
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    expect(sink.out.some((l) => l.includes('session not in registry'))).toBe(true)
  })

  test('live source error surfaces as a stderr warning, then end-of-transcript still prints', async () => {
    await seedSession(`a_${ID_ERR}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const sink = captureSink()
    async function* failingLive(): AsyncGenerator<import('./types').InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'x' } }
      throw new Error('upstream blew up')
    }
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_ERR,
      color: false,
      selectSession: neverPick,
      liveSource: () => failingLive(),
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    expect(sink.err.some((l) => l.includes('upstream blew up'))).toBe(true)
    expect(sink.out.at(-1)!).toContain('end of transcript')
  })

  test('without liveSource: same as before (replay-then-exit)', async () => {
    await seedSession(`a_${ID_NO_LIVE}.jsonl`, [metaLine({ kind: 'tui' }), userLine('hi')], 1000)
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_NO_LIVE,
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    expect(sink.out.find((l) => l.includes('─── live'))).toBeUndefined()
    expect(sink.out.at(-1)!).toContain('end of transcript')
  })

  test('signal abort during live stream sets escToPicker=true', async () => {
    // runInspect no longer distinguishes esc from exit: any signal abort during
    // the tail yields escToPicker=true. The caller's loop reads its scope intent
    // to decide whether to re-open the picker (esc) or exit (q/ctrl-c).
    await seedSession(`a_${ID_LIVET}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const ctrl = new AbortController()
    const sink = captureSink()
    async function* live(signal: AbortSignal | undefined): AsyncGenerator<import('./types').InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'tick' } }
      await new Promise<void>((resolve) => {
        if (signal === undefined || signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    queueMicrotask(() => ctrl.abort())
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_LIVET,
      color: false,
      selectSession: neverPick,
      liveSource: (o) => live(o.signal),
      signal: ctrl.signal,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.escToPicker).toBe(true)
  })

  test('finite live stream that ends on its own does not set escToPicker', async () => {
    await seedSession(`a_${ID_LIVET}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const sink = captureSink()
    async function* live(): AsyncGenerator<import('./types').InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'tick' } }
    }
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_LIVET,
      color: false,
      selectSession: neverPick,
      liveSource: () => live(),
      signal: new AbortController().signal,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.escToPicker).toBeFalsy()
  })

  test('replay-only interactive prints the end-of-transcript footer exactly once', async () => {
    // Regression: the streamSessionEvents refactor briefly printed the footer
    // twice (at replay-only-idle AND at end) when the interactive viewer aborted.
    await seedSession(`a_${ID_LIVET}.jsonl`, [metaLine({ kind: 'tui' }), userLine('hi')], 1000)
    const ctrl = new AbortController()
    const sink = captureSink()
    // Abort AFTER replay finishes and the viewer is parked in the idle wait, so
    // the footer is reached (aborting during replay would skip it entirely).
    setTimeout(() => ctrl.abort(), 30)
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: ID_LIVET,
      color: false,
      interactive: true,
      selectSession: neverPick,
      signal: ctrl.signal,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    const footers = sink.out.filter((l) => l.includes('end of transcript'))
    expect(footers).toHaveLength(1)
  })
})

describe('runInspect — picker path', () => {
  test('empty sessions dir returns exit 1 with a remediation hint', async () => {
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(1)
    expect(result.reason).toContain('No sessions found')
    expect(result.reason).toContain('typeclaw tui')
  })

  test('passes session summaries to selectSession and replays the picked one', async () => {
    await seedSession(`a_${ID_PICK1}.jsonl`, [metaLine({ kind: 'tui' }), userLine('first')], 1000)
    await seedSession(`b_${ID_PICK2}.jsonl`, [metaLine({ kind: 'tui' }), userLine('second')], 2000)
    let offered: SessionSummary[] = []
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      color: false,
      selectSession: async (sessions) => {
        offered = sessions
        return sessions.find((s) => s.sessionId === ID_PICK1) ?? null
      },
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    expect(offered.map((s) => s.sessionId).sort()).toEqual([ID_PICK1, ID_PICK2])
    expect(sink.out[0]!).toContain(ID_PICK1.slice(0, 12))
  })

  test('cancelled picker returns exit 130 (Ctrl-C convention)', async () => {
    await seedSession(`a_${ID_ABC}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      color: false,
      selectSession: async () => null,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(130)
  })

  test('--json without session id is rejected', async () => {
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      json: true,
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(2)
    expect(result.reason).toContain('--json requires an explicit session id')
  })

  test('--json with a non-id-shaped argument is rejected (interactive picker not allowed)', async () => {
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'abc',
      json: true,
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(2)
    expect(result.reason).toContain('--json requires an explicit session id')
  })
})
