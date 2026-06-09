import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Markdown, type Terminal, Text } from '@mariozechner/pi-tui'

import type { SessionSummary } from './session-list'
import { BoundedComponentWindow, createTranscriptView, componentFor } from './transcript-view'
import type { InspectEvent } from './types'
import { parseFilter } from './types'

class FakeTerminal implements Terminal {
  rows = 30
  columns = 80
  kittyProtocolActive = false
  stopped = false
  readonly writes: string[] = []
  private inputHandler: ((data: string) => void) | null = null

  start(onInput: (data: string) => void): void {
    this.inputHandler = onInput
  }
  stop(): void {
    this.stopped = true
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data)
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  feed(data: string): void {
    this.inputHandler?.(data)
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('componentFor', () => {
  test('assistant text becomes a Markdown block', () => {
    const ev: InspectEvent = { cat: 'assistant', ts: 1, text: '# hi\n\nbody' }
    expect(componentFor(ev)).toBeInstanceOf(Markdown)
  })

  test('user / tool / meta / done become Text components', () => {
    const cases: InspectEvent[] = [
      { cat: 'user', ts: 1, text: 'hello' },
      { cat: 'tool', ts: 1, phase: 'start', toolCallId: 'c1', name: 'read', args: { path: 'x' } },
      {
        cat: 'tool',
        ts: 1,
        phase: 'end',
        toolCallId: 'c1',
        name: 'read',
        result: 'ok',
        isError: false,
        durationMs: 12,
      },
      { cat: 'meta', ts: 1, origin: { kind: 'tui' } },
      { cat: 'done', ts: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.01 },
      { cat: 'error', ts: 1, message: 'boom' },
    ]
    for (const ev of cases) expect(componentFor(ev)).toBeInstanceOf(Text)
  })
})

describe('BoundedComponentWindow', () => {
  test('keeps every entry until the cap is reached', () => {
    const window = new BoundedComponentWindow(3)
    expect(window.push([new Text('a', 0, 0)])).toBeNull()
    expect(window.push([new Text('b', 0, 0)])).toBeNull()
    expect(window.push([new Text('c', 0, 0)])).toBeNull()
    expect(window.size).toBe(3)
  })

  test('evicts the oldest entry once the cap is exceeded', () => {
    const window = new BoundedComponentWindow(2)
    const first = [new Text('first', 0, 0)]
    const second = [new Text('second', 0, 0)]
    const third = [new Text('third', 0, 0)]

    expect(window.push(first)).toBeNull()
    expect(window.push(second)).toBeNull()
    expect(window.push(third)).toBe(first)
    expect(window.size).toBe(2)
  })

  test('evicts the whole entry so a timestamp never outlives its body', () => {
    const window = new BoundedComponentWindow(1)
    const timestamp = new Text('12:00:00', 0, 0)
    const body = new Text('assistant reply', 0, 0)
    const firstEntry = [timestamp, body]
    const secondEntry = [new Text('12:00:01', 0, 0), new Text('next', 0, 0)]

    expect(window.push(firstEntry)).toBeNull()
    const evicted = window.push(secondEntry)
    expect(evicted).toBe(firstEntry)
    expect(evicted).toContain(timestamp)
    expect(evicted).toContain(body)
    expect(window.size).toBe(1)
  })
})

describe('createTranscriptView run()', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-transcript-view-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const FILTER = parseFilter(undefined)
  if (!FILTER.ok) throw new Error('default filter')

  async function seed(): Promise<SessionSummary> {
    const file = join(dir, 's.jsonl')
    const lines = [
      JSON.stringify({
        type: 'custom',
        customType: 'typeclaw.session-meta',
        data: { origin: { kind: 'tui' } },
        timestamp: 1,
      }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi', timestamp: 2 } }),
    ]
    await writeFile(file, lines.join('\n') + '\n')
    return {
      sessionId: 's',
      sessionFile: file,
      basename: 's.jsonl',
      mtimeMs: 1,
      origin: { kind: 'tui' },
      firstPrompt: null,
    }
  }

  test('esc returns back; the terminal is stopped', async () => {
    const summary = await seed()
    const terminal = new FakeTerminal()
    const view = createTranscriptView({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      createTerminal: () => terminal,
    })

    const runPromise = view.run()
    await flush()
    terminal.feed('\x1b')

    await expect(runPromise).resolves.toEqual({ reason: 'back' })
    expect(terminal.stopped).toBe(true)
  })

  test('q exits', async () => {
    const summary = await seed()
    const terminal = new FakeTerminal()
    const view = createTranscriptView({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      createTerminal: () => terminal,
    })

    const runPromise = view.run()
    await flush()
    terminal.feed('q')

    await expect(runPromise).resolves.toEqual({ reason: 'exit' })
  })

  test('ctrl-c exits', async () => {
    const summary = await seed()
    const terminal = new FakeTerminal()
    const view = createTranscriptView({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      createTerminal: () => terminal,
    })

    const runPromise = view.run()
    await flush()
    terminal.feed('\x03')

    await expect(runPromise).resolves.toEqual({ reason: 'exit' })
  })

  test('a run of same-category events renders the timestamp on the first block only, not the second', async () => {
    // given: an assistant turn with two consecutive thinking blocks (one shared ts)
    const ts = Date.parse('2026-06-10T08:00:00.000Z')
    const file = join(dir, 'group.jsonl')
    await writeFile(
      file,
      JSON.stringify({
        type: 'message',
        timestamp: new Date(ts).toISOString(),
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'first thought' },
            { type: 'thinking', thinking: 'second thought' },
          ],
          timestamp: ts,
        },
      }) + '\n',
    )
    const groupSummary: SessionSummary = {
      sessionId: 'g',
      sessionFile: file,
      basename: 'group.jsonl',
      mtimeMs: 1,
      origin: { kind: 'tui' },
      firstPrompt: null,
    }
    const terminal = new FakeTerminal()
    const view = createTranscriptView({
      summary: groupSummary,
      filter: FILTER.filter,
      sinceMs: undefined,
      createTerminal: () => terminal,
    })

    // when: the viewer replays and we dismiss it
    const runPromise = view.run()
    await flush()
    terminal.feed('\x1b')
    await runPromise

    // then: the final frame shows both thoughts but the HH:MM:SS stamp exactly once
    const p = (n: number): string => String(n).padStart(2, '0')
    const d = new Date(ts)
    const stamp = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    const frame = terminal.writes.join('')
    expect(frame).toContain('first thought')
    expect(frame).toContain('second thought')
    expect(frame.split(stamp).length - 1).toBe(1)
  })
})
