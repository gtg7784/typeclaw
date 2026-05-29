import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { replayJsonl, replayLines } from './replay'
import type { InspectEvent } from './types'

async function collect(gen: AsyncIterable<InspectEvent>): Promise<InspectEvent[]> {
  const out: InspectEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

async function* asLines(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line
}

describe('replayLines', () => {
  test('session-meta line yields one meta event with the persisted origin', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'custom',
            customType: 'typeclaw.session-meta',
            data: { origin: { kind: 'tui' } },
            timestamp: 1000,
          }),
        ]),
      ),
    )
    expect(events).toEqual([{ cat: 'meta', ts: 1000, origin: { kind: 'tui' } }])
  })

  test('channel meta with workspaceName/chatName round-trips verbatim', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'custom',
            customType: 'typeclaw.session-meta',
            data: {
              origin: {
                kind: 'channel',
                adapter: 'slack-bot',
                workspace: 'T0123',
                workspaceName: 'Acme',
                chat: 'C0ABC',
                chatName: 'general',
                thread: null,
              },
            },
            timestamp: 100,
          }),
        ]),
      ),
    )
    expect(events).toHaveLength(1)
    const ev = events[0]!
    if (ev.cat !== 'meta') throw new Error('expected meta')
    if (ev.origin.kind !== 'channel') throw new Error('expected channel origin')
    expect(ev.origin.workspaceName).toBe('Acme')
    expect(ev.origin.chatName).toBe('general')
  })

  test('user message with string content yields a user event', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: { role: 'user', content: 'fix the type error', timestamp: 2000 },
          }),
        ]),
      ),
    )
    expect(events).toEqual([{ cat: 'user', ts: 2000, text: 'fix the type error' }])
  })

  test('user message with content blocks concatenates text segments', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'hello ' },
                { type: 'text', text: 'world' },
                { type: 'image', source: 'ignored' },
              ],
              timestamp: 3000,
            },
          }),
        ]),
      ),
    )
    expect(events).toEqual([{ cat: 'user', ts: 3000, text: 'hello world' }])
  })

  test('assistant message emits text, tool calls, tool results, and done with token totals', async () => {
    const lines = [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'fireworks',
          model: 'kimi-k2',
          content: [
            { type: 'text', text: 'reading file' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'x' } },
          ],
          stopReason: 'tool_use',
          usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            cost: { total: 0.0012 },
          },
          timestamp: 10_000,
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolResult', toolCallId: 'c1', output: 'file contents', isError: false }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { total: 0 },
          },
          timestamp: 11_500,
        },
      }),
    ]
    const events = await collect(replayLines(asLines(lines)))
    expect(events.map((e) => e.cat)).toEqual(['assistant', 'tool', 'done', 'tool'])

    const start = events[1]!
    if (start.cat !== 'tool' || start.phase !== 'start') throw new Error('expected tool start')
    expect(start.name).toBe('read')
    expect(start.args).toEqual({ path: 'x' })

    const end = events[3]!
    if (end.cat !== 'tool' || end.phase !== 'end') throw new Error('expected tool end')
    expect(end.name).toBe('read')
    expect(end.durationMs).toBe(1500)
    expect(end.isError).toBe(false)
    expect(end.result).toBe('file contents')

    const done0 = events[2]!
    if (done0.cat !== 'done') throw new Error('expected done')
    expect(done0.input).toBe(100)
    expect(done0.totalTokens).toBe(150)
    expect(done0.cost).toBe(0.0012)
  })

  test('message events use the JSONL entry timestamp over the nested provider timestamp', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            timestamp: '2026-05-27T05:38:47.773Z',
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'ready' },
                { type: 'toolCall', id: 'c1', name: 'channel_reply', arguments: { text: 'ack' } },
              ],
              stopReason: 'toolUse',
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
              timestamp: 1779860021370,
            },
          }),
          JSON.stringify({
            type: 'message',
            timestamp: '2026-05-27T05:38:48.506Z',
            message: {
              role: 'toolResult',
              toolCallId: 'c1',
              toolName: 'channel_reply',
              content: [{ type: 'text', text: 'posted' }],
              isError: false,
              timestamp: 1779860021370,
            },
          }),
        ]),
      ),
    )

    const expectedStart = Date.parse('2026-05-27T05:38:47.773Z')
    const expectedEnd = Date.parse('2026-05-27T05:38:48.506Z')
    expect(events.map((event) => event.ts)).toEqual([expectedStart, expectedStart, expectedStart, expectedEnd])

    const toolEnd = events[3]!
    if (toolEnd.cat !== 'tool' || toolEnd.phase !== 'end') throw new Error('expected tool end')
    expect(toolEnd.durationMs).toBe(expectedEnd - expectedStart)
  })

  test('assistant turn with zero usage and no stopReason yields no done event (avoids noisy "(no usage)" lines on tool-result turns)', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'toolResult', toolCallId: 'c1', output: 'x', isError: false }],
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
              timestamp: 1000,
            },
          }),
        ]),
      ),
    )
    expect(events.find((e) => e.cat === 'done')).toBeUndefined()
  })

  test('assistant errorMessage surfaces as error event', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [],
              errorMessage: 'provider returned 503',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
              timestamp: 5000,
            },
          }),
        ]),
      ),
    )
    const errorEvent = events.find((e) => e.cat === 'error')
    expect(errorEvent).toBeDefined()
    if (errorEvent?.cat !== 'error') throw new Error('unreachable')
    expect(errorEvent.message).toBe('provider returned 503')
  })

  test('assistant errorMessage carries stopReason onto the error event', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [],
              stopReason: 'aborted',
              errorMessage: 'Request was aborted.',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
              timestamp: 5000,
            },
          }),
        ]),
      ),
    )
    const errorEvent = events.find((e) => e.cat === 'error')
    expect(errorEvent).toBeDefined()
    if (errorEvent?.cat !== 'error') throw new Error('unreachable')
    expect(errorEvent.stopReason).toBe('aborted')
  })

  test('assistant thinking content block yields a thinking event ordered before text and tool calls', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'Need to read the file to know its shape.' },
                { type: 'text', text: 'Reading the file now.' },
                { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'x' } },
              ],
              stopReason: 'toolUse',
              usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0.0001 } },
              timestamp: 10_000,
            },
          }),
        ]),
      ),
    )
    expect(events.map((e) => e.cat)).toEqual(['thinking', 'assistant', 'tool', 'done'])
    const thinking = events[0]!
    if (thinking.cat !== 'thinking') throw new Error('expected thinking')
    expect(thinking.text).toBe('Need to read the file to know its shape.')
    expect(thinking.ts).toBe(10_000)
    expect(thinking.redacted).toBeUndefined()
  })

  test('multiple thinking blocks in one turn each yield a thinking event in content-array order', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'first thought' },
                { type: 'thinking', thinking: 'second thought' },
                { type: 'text', text: 'done thinking' },
              ],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
              timestamp: 5_000,
            },
          }),
        ]),
      ),
    )
    const thinks = events.filter((e) => e.cat === 'thinking')
    expect(thinks).toHaveLength(2)
    if (thinks[0]!.cat !== 'thinking' || thinks[1]!.cat !== 'thinking') throw new Error('unreachable')
    expect(thinks[0]!.text).toBe('first thought')
    expect(thinks[1]!.text).toBe('second thought')
  })

  test('redacted thinking block surfaces with redacted:true and empty text (so users see the safety-filter cut, not silence)', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: '', redacted: true, thinkingSignature: 'opaque-blob' },
                { type: 'text', text: 'I cannot show my reasoning here.' },
              ],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
              timestamp: 5_000,
            },
          }),
        ]),
      ),
    )
    const thinking = events.find((e) => e.cat === 'thinking')
    expect(thinking).toBeDefined()
    if (thinking?.cat !== 'thinking') throw new Error('unreachable')
    expect(thinking.redacted).toBe(true)
    expect(thinking.text).toBe('')
  })

  test('empty non-redacted thinking block is dropped (no noise)', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: '' },
                { type: 'text', text: 'hello' },
              ],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
              timestamp: 5_000,
            },
          }),
        ]),
      ),
    )
    expect(events.find((e) => e.cat === 'thinking')).toBeUndefined()
    expect(events.find((e) => e.cat === 'assistant')).toBeDefined()
  })

  test('malformed JSON lines are skipped, surrounding events still emit', async () => {
    const warnings: string[] = []
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({ type: 'message', message: { role: 'user', content: 'a', timestamp: 1 } }),
          '{ this is not valid json',
          JSON.stringify({ type: 'message', message: { role: 'user', content: 'b', timestamp: 2 } }),
        ]),
        { onWarn: (m) => warnings.push(m) },
      ),
    )
    expect(events.map((e) => e.cat)).toEqual(['user', 'user'])
    expect(warnings).toHaveLength(1)
  })

  test('blank lines are ignored without warning', async () => {
    const warnings: string[] = []
    const events = await collect(
      replayLines(
        asLines(['', '  ', JSON.stringify({ type: 'message', message: { role: 'user', content: 'x', timestamp: 1 } })]),
        {
          onWarn: (m) => warnings.push(m),
        },
      ),
    )
    expect(events).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })

  test('unknown entry types are ignored silently (forward-compat with new pi-coding-agent fields)', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({ type: 'session', id: 's1', startedAt: 0 }),
          JSON.stringify({ type: 'custom', customType: 'someone.elses.namespace', data: { x: 1 } }),
          JSON.stringify({ type: 'message', message: { role: 'system', content: 'sys', timestamp: 1 } }),
        ]),
      ),
    )
    expect(events).toEqual([])
  })

  test('top-level role:toolResult message (real pi-coding-agent format) yields a tool end event with text joined from content parts', async () => {
    // Real pi-coding-agent emits toolResult as its own top-level message, not as a block inside the prior assistant message.
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'toolCall', id: 'functions.read:0', name: 'read', arguments: { path: '/agent/x.md' } }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
              stopReason: 'toolUse',
              timestamp: 1_000,
            },
          }),
          JSON.stringify({
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: 'functions.read:0',
              toolName: 'read',
              content: [{ type: 'text', text: 'Successfully read /agent/x.md' }],
              isError: false,
              timestamp: 1_250,
            },
          }),
        ]),
      ),
    )
    const ends = events.filter((e) => e.cat === 'tool' && e.phase === 'end')
    expect(ends).toHaveLength(1)
    const end = ends[0]!
    if (end.cat !== 'tool' || end.phase !== 'end') throw new Error('unreachable')
    expect(end.name).toBe('read')
    expect(end.toolCallId).toBe('functions.read:0')
    expect(end.isError).toBe(false)
    expect(end.result).toBe('Successfully read /agent/x.md')
    expect(end.durationMs).toBe(250)
  })

  test('top-level role:toolResult with isError surfaces error status', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'toolCall', id: 'bash:0', name: 'bash', arguments: { command: 'false' } }],
              timestamp: 1_000,
            },
          }),
          JSON.stringify({
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: 'bash:0',
              toolName: 'bash',
              content: [{ type: 'text', text: 'exit code 1' }],
              isError: true,
              timestamp: 1_100,
            },
          }),
        ]),
      ),
    )
    const end = events.find((e) => e.cat === 'tool' && e.phase === 'end')
    if (end === undefined || end.cat !== 'tool' || end.phase !== 'end') throw new Error('expected tool end')
    expect(end.isError).toBe(true)
    expect(end.result).toBe('exit code 1')
  })

  test('top-level role:toolResult joins multiple text parts and surfaces tool-result-cap markers verbatim', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'toolCall', id: 'read:0', name: 'read', arguments: { path: 'big.txt' } }],
              timestamp: 1_000,
            },
          }),
          JSON.stringify({
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: 'read:0',
              toolName: 'read',
              content: [
                { type: 'text', text: 'first chunk' },
                {
                  type: 'text',
                  text: '\n\n[tool-result-cap: 5000 bytes truncated from text part; original was 65536 bytes, textMaxBytes=65536]',
                },
              ],
              isError: false,
              timestamp: 1_100,
            },
          }),
        ]),
      ),
    )
    const end = events.find((e) => e.cat === 'tool' && e.phase === 'end')
    if (end === undefined || end.cat !== 'tool' || end.phase !== 'end') throw new Error('expected tool end')
    expect(end.result).toContain('first chunk')
    expect(end.result).toContain('[tool-result-cap:')
  })

  test('top-level role:toolResult without a matching prior toolCall still emits a tool end (defensive: name from toolName)', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: 'orphan:0',
              toolName: 'read',
              content: [{ type: 'text', text: 'orphan result' }],
              isError: false,
              timestamp: 5_000,
            },
          }),
        ]),
      ),
    )
    expect(events).toHaveLength(1)
    const end = events[0]!
    if (end.cat !== 'tool' || end.phase !== 'end') throw new Error('expected tool end')
    expect(end.name).toBe('read')
    expect(end.durationMs).toBe(0)
    expect(end.result).toBe('orphan result')
  })

  test('top-level role:toolResult message does NOT emit a spurious done event', async () => {
    const events = await collect(
      replayLines(
        asLines([
          JSON.stringify({
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: 'read:0',
              toolName: 'read',
              content: [{ type: 'text', text: 'x' }],
              isError: false,
              timestamp: 1_000,
            },
          }),
        ]),
      ),
    )
    expect(events.find((e) => e.cat === 'done')).toBeUndefined()
  })
})

describe('replayJsonl (real file in tmpdir)', () => {
  test('reads a small JSONL file end-to-end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-inspect-replay-'))
    try {
      const file = join(dir, 'test.jsonl')
      await writeFile(
        file,
        [
          JSON.stringify({
            type: 'custom',
            customType: 'typeclaw.session-meta',
            data: { origin: { kind: 'tui' } },
            timestamp: 0,
          }),
          JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi', timestamp: 1000 } }),
        ].join('\n') + '\n',
      )
      const events = await collect(replayJsonl(file))
      expect(events.map((e) => e.cat)).toEqual(['meta', 'user'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('missing file is reported via onWarn and yields no events (rather than throwing)', async () => {
    const warnings: string[] = []
    const events = await collect(replayJsonl('/this/path/does/not/exist.jsonl', { onWarn: (m) => warnings.push(m) }))
    expect(events).toEqual([])
  })
})
