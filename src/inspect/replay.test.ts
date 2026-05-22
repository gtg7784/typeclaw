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
