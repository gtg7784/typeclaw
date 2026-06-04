import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Markdown, type Terminal, Text } from '@mariozechner/pi-tui'

import type { SessionSummary } from './session-list'
import { createTranscriptView, componentFor } from './transcript-view'
import type { InspectEvent } from './types'
import { parseFilter } from './types'

class FakeTerminal implements Terminal {
  rows = 30
  columns = 80
  kittyProtocolActive = false
  stopped = false
  private inputHandler: ((data: string) => void) | null = null

  start(onInput: (data: string) => void): void {
    this.inputHandler = onInput
  }
  stop(): void {
    this.stopped = true
  }
  async drainInput(): Promise<void> {}
  write(): void {}
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
})
