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

describe('runInspect — direct session id (replay-then-exit)', () => {
  test('replays meta, user, assistant, done in order; returns ok', async () => {
    await seedSession(
      '2026-05-22T00-00-00-000Z_ses_abc.jsonl',
      [metaLine({ kind: 'tui' }), userLine('hi'), assistantLine('hello')],
      1000,
    )
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'ses_abc',
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const stripTime = (l: string) => l.replace(/\d{2}:\d{2}:\d{2}/, 'HH:MM:SS')
    const cats = sink.out.slice(1, -1).map((l) => stripTime(l).split('  ')[1]?.trim())
    expect(cats).toEqual(['meta', 'user', 'assist', 'done'])
    expect(sink.out[0]!).toContain('ses_abc')
    expect(sink.out[0]!).toContain('TUI')
    expect(sink.out.at(-1)!).toContain('end of transcript')
  })

  test('--json emits one event per line and omits the header/footer', async () => {
    await seedSession('a_ses_jsonout.jsonl', [metaLine({ kind: 'tui' }), userLine('hi')], 1000)
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'ses_jsonout',
      json: true,
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    expect(sink.out.every((l) => l.startsWith('{'))).toBe(true)
    for (const line of sink.out) {
      const parsed = JSON.parse(line)
      expect(parsed.sessionId).toBe('ses_jsonout')
      expect(typeof parsed.cat).toBe('string')
    }
  })

  test('filter narrows which events render', async () => {
    await seedSession(
      'a_ses_filt.jsonl',
      [metaLine({ kind: 'tui' }), userLine('a'), userLine('b'), assistantLine('hello')],
      1000,
    )
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'ses_filt',
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
      'a_ses_since.jsonl',
      [metaLine({ kind: 'tui' }), userLine('old', Date.now() - 86_400_000), userLine('new', Date.now())],
      1000,
    )
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'ses_since',
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
      sessionIdOrPrefix: 'ses_does_not_matter',
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
      sessionIdOrPrefix: 'ses_x',
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
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'ses_ghost',
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(1)
    expect(result.reason).toContain('ses_ghost')
  })

  test('ambiguous prefix returns exit 2 with all matches listed', async () => {
    await seedSession('a_ses_abcd111.jsonl', [metaLine({ kind: 'tui' })], 1000)
    await seedSession('b_ses_abcd222.jsonl', [metaLine({ kind: 'tui' })], 2000)
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'ses_abcd',
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(2)
    expect(result.reason).toContain('ses_abcd111')
    expect(result.reason).toContain('ses_abcd222')
  })
})

describe('runInspect — live tail (when liveSource is provided)', () => {
  test('replays JSONL then prints the live divider, then yields live events', async () => {
    await seedSession('a_ses_livet.jsonl', [metaLine({ kind: 'tui' }), userLine('hi')], 1000)
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
      sessionIdOrPrefix: 'ses_livet',
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
    await seedSession('a_ses_dead.jsonl', [metaLine({ kind: 'tui' })], 1000)
    const sink = captureSink()
    async function* fakeLive(): AsyncGenerator<import('./types').InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'cron-fired' } }
    }
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'ses_dead',
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
    await seedSession('a_ses_err.jsonl', [metaLine({ kind: 'tui' })], 1000)
    const sink = captureSink()
    async function* failingLive(): AsyncGenerator<import('./types').InspectEvent> {
      yield { cat: 'broadcast', ts: Date.now(), payload: { kind: 'x' } }
      throw new Error('upstream blew up')
    }
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'ses_err',
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
    await seedSession('a_ses_no_live.jsonl', [metaLine({ kind: 'tui' }), userLine('hi')], 1000)
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      sessionIdOrPrefix: 'ses_no_live',
      color: false,
      selectSession: neverPick,
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    expect(sink.out.find((l) => l.includes('─── live'))).toBeUndefined()
    expect(sink.out.at(-1)!).toContain('end of transcript')
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
    await seedSession('a_ses_pick1.jsonl', [metaLine({ kind: 'tui' }), userLine('first')], 1000)
    await seedSession('b_ses_pick2.jsonl', [metaLine({ kind: 'tui' }), userLine('second')], 2000)
    let offered: SessionSummary[] = []
    const sink = captureSink()
    const result = await runInspect({
      agentDir,
      color: false,
      selectSession: async (sessions) => {
        offered = sessions
        return sessions.find((s) => s.sessionId === 'ses_pick1') ?? null
      },
      ...sink.push,
    })
    expect(result.ok).toBe(true)
    expect(offered.map((s) => s.sessionId).sort()).toEqual(['ses_pick1', 'ses_pick2'])
    expect(sink.out[0]!).toContain('ses_pick1')
  })

  test('cancelled picker returns exit 130 (Ctrl-C convention)', async () => {
    await seedSession('a_ses_x.jsonl', [metaLine({ kind: 'tui' })], 1000)
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
})
