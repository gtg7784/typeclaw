import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { streamSessionEvents, type StreamPhase } from './index'
import type { SessionSummary } from './session-list'
import type { InspectEvent } from './types'
import { parseFilter } from './types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'typeclaw-stream-events-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const FILTER = parseFilter(undefined)
if (!FILTER.ok) throw new Error('default filter must parse')

function metaLine(origin: unknown): string {
  return JSON.stringify({ type: 'custom', customType: 'typeclaw.session-meta', data: { origin }, timestamp: 1_000_000 })
}
function userLine(text: string, ts = 1_000_100): string {
  return JSON.stringify({ type: 'message', message: { role: 'user', content: text, timestamp: ts } })
}

async function seed(lines: string[]): Promise<SessionSummary> {
  const file = join(dir, 'sess.jsonl')
  await writeFile(file, lines.join('\n') + '\n')
  return {
    sessionId: 'sess',
    sessionFile: file,
    basename: 'sess.jsonl',
    mtimeMs: 1,
    origin: { kind: 'tui' },
    firstPrompt: null,
  }
}

describe('streamSessionEvents', () => {
  test('replay-only delivers events then announces replay-end and end', async () => {
    const summary = await seed([metaLine({ kind: 'tui' }), userLine('hello')])
    const events: InspectEvent[] = []
    const phases: StreamPhase['phase'][] = []

    const result = await streamSessionEvents({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      onEvent: (e) => events.push(e),
      onPhase: (p) => phases.push(p.phase),
    })

    expect(result).toEqual({ escToPicker: false })
    expect(events.map((e) => e.cat)).toEqual(['meta', 'user'])
    expect(phases).toEqual(['replay-end', 'end'])
  })

  test('replay then live preserves ordering and announces live-start with sessionLive', async () => {
    const summary = await seed([metaLine({ kind: 'tui' }), userLine('first')])
    const events: InspectEvent[] = []
    const phases: StreamPhase[] = []

    async function* live(o: { onSubscribed?: (live: boolean) => void }): AsyncGenerator<InspectEvent> {
      o.onSubscribed?.(true)
      yield { cat: 'broadcast', ts: 2_000, payload: { kind: 'tick' } }
    }

    const result = await streamSessionEvents({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      onEvent: (e) => events.push(e),
      onPhase: (p) => phases.push(p),
      liveSource: (o) => live(o),
    })

    expect(result).toEqual({ escToPicker: false })
    expect(events.map((e) => e.cat)).toEqual(['meta', 'user', 'broadcast'])
    expect(phases.map((p) => p.phase)).toEqual(['replay-end', 'live-start', 'end'])
    const liveStart = phases.find((p) => p.phase === 'live-start')
    expect(liveStart).toEqual({ phase: 'live-start', sessionLive: true })
  })

  test('abort during live tail returns escToPicker', async () => {
    const summary = await seed([metaLine({ kind: 'tui' })])
    const ctrl = new AbortController()
    const events: InspectEvent[] = []

    async function* live(o: { signal?: AbortSignal }): AsyncGenerator<InspectEvent> {
      yield { cat: 'broadcast', ts: 2_000, payload: { kind: 'one' } }
      await new Promise<void>((resolve) => {
        if (o.signal?.aborted) return resolve()
        o.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    }

    const promise = streamSessionEvents({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      onEvent: (e) => {
        events.push(e)
        if (e.cat === 'broadcast') ctrl.abort()
      },
      liveSource: (o) => live(o),
      signal: ctrl.signal,
    })

    const result = await promise
    expect(result).toEqual({ escToPicker: true })
  })

  test('since cutoff and filter are applied before onEvent', async () => {
    const summary = await seed([metaLine({ kind: 'tui' }), userLine('old', 1_000), userLine('new', 9_000)])
    const filtered = parseFilter('!meta')
    if (!filtered.ok) throw new Error('filter parse')
    const events: InspectEvent[] = []

    await streamSessionEvents({
      summary,
      filter: filtered.filter,
      sinceMs: 5_000,
      onEvent: (e) => events.push(e),
    })

    // meta excluded by filter; 'old' (ts 1000) dropped by since; only 'new' remains
    expect(events.map((e) => e.cat)).toEqual(['user'])
    expect(events[0]).toMatchObject({ cat: 'user', text: 'new' })
  })

  test('blockWhenReplayOnly waits for the signal before ending', async () => {
    const summary = await seed([metaLine({ kind: 'tui' })])
    const ctrl = new AbortController()
    const phases: StreamPhase['phase'][] = []

    const promise = streamSessionEvents({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      onEvent: () => {},
      onPhase: (p) => phases.push(p.phase),
      signal: ctrl.signal,
      blockWhenReplayOnly: true,
    })

    // Has not ended yet; idle phase announced, waiting on the signal.
    await new Promise((r) => setTimeout(r, 20))
    expect(phases).toEqual(['replay-end', 'replay-only-idle'])

    ctrl.abort()
    const result = await promise
    expect(result).toEqual({ escToPicker: true })
    expect(phases).toEqual(['replay-end', 'replay-only-idle', 'end'])
  })
})
