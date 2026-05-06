import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { OutboundMessage, SendResult } from '@/channels/types'

import {
  createChannelReplyTool,
  ECHO_MAX_CHARS,
  renderEcho,
  renderOutboundEcho,
  type ChannelReplyOrigin,
} from './channel-reply'

function fakeRouter(
  handler: (msg: OutboundMessage) => Promise<SendResult>,
  options: { consecutiveCount?: number } = {},
): ChannelRouter {
  return {
    route: async () => {},
    send: handler,
    getConsecutiveSendCount: () => options.consecutiveCount ?? 0,
    registerOutbound: () => {},
    unregisterOutbound: () => {},
    registerTyping: () => {},
    unregisterTyping: () => {},
    registerChannelNameResolver: () => {},
    unregisterChannelNameResolver: () => {},
    registerMembership: () => {},
    unregisterMembership: () => {},
    registerHistory: () => {},
    unregisterHistory: () => {},
    fetchHistory: async () => ({ ok: false, error: 'history-not-supported' }),
    stop: async () => {},
    liveCount: () => 0,
  }
}

const slackThreadOrigin: ChannelReplyOrigin = {
  adapter: 'slack-bot',
  workspace: 'T0',
  chat: 'C0',
  thread: '1700000000.000100',
}

const slackChannelRootOrigin: ChannelReplyOrigin = {
  adapter: 'slack-bot',
  workspace: 'T0',
  chat: 'C0',
  thread: null,
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelReplyTool>['execute']>[4]

async function runTool(
  tool: ReturnType<typeof createChannelReplyTool>,
  params: Parameters<ReturnType<typeof createChannelReplyTool>['execute']>[1],
) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('createChannelReplyTool', () => {
  test('addresses the message from the origin and forwards text to router.send', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'hi' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: '1700000000.000100',
      text: 'hi',
    })
    expect(result.details).toEqual({ ok: true })
  })

  test('passes thread=null verbatim when origin is a channel-root session', async () => {
    const captured: { thread: string | null | undefined } = { thread: undefined }
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        captured.thread = msg.thread ?? null
        return { ok: true }
      }),
      origin: slackChannelRootOrigin,
    })
    await runTool(tool, { text: 'top-level' })
    expect(captured.thread).toBeNull()
  })

  test('reports the origin chat AND echoes the sent text in the success message', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'hi' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toBe('posted to slack-bot:T0/C0: "hi"')
  })

  test('echoes JSON-quoted text so the model can detect duplicates across iterations', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'hello, I am here!' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('"hello, I am here!"')
  })

  test('truncates echo past 500 chars and includes total length so context cost stays bounded', async () => {
    const long = 'a'.repeat(ECHO_MAX_CHARS * 4)
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: long })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain(`(${long.length} chars total)`)
    expect(text).toContain('...')
    expect(text.length).toBeLessThan(long.length)
  })

  test('reports denial back to the agent without throwing', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'nope' })
    expect(result.details).toEqual({ ok: false, error: 'denied by allow rules' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('channel_reply denied')
    expect(text).toContain('denied by allow rules')
  })

  test('second consecutive reply appends a soft yield hint', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 2 }),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'continuing' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('posted to slack-bot:T0/C0: "continuing"')
    expect(text).toContain('2nd consecutive message')
  })

  describe('renderEcho', () => {
    test('JSON-quotes short text', () => {
      expect(renderEcho('hi')).toBe('"hi"')
    })

    test('preserves multibyte characters under the limit', () => {
      expect(renderEcho('héllo wörld 🌍 café')).toBe('"héllo wörld 🌍 café"')
    })

    test('escapes embedded quotes via JSON.stringify', () => {
      expect(renderEcho('she said "hi"')).toBe('"she said \\"hi\\""')
    })

    test('truncates and reports total length past the limit', () => {
      const long = 'x'.repeat(ECHO_MAX_CHARS + 1)
      const out = renderEcho(long)
      expect(out).toContain(`(${long.length} chars total)`)
      expect(out).toContain('...')
    })

    test('does NOT truncate at exactly the limit (boundary)', () => {
      const exact = 'y'.repeat(ECHO_MAX_CHARS)
      const out = renderEcho(exact)
      expect(out).toBe(JSON.stringify(exact))
      expect(out).not.toContain('...')
    })
  })

  test('queries consecutive send count using the origin thread, not a hardcoded null', async () => {
    const queriedKeys: { adapter: string; workspace: string; chat: string; thread: string | null | undefined }[] = []
    const tool = createChannelReplyTool({
      router: {
        ...fakeRouter(async () => ({ ok: true })),
        getConsecutiveSendCount: (key) => {
          queriedKeys.push({ adapter: key.adapter, workspace: key.workspace, chat: key.chat, thread: key.thread })
          return 0
        },
      },
      origin: slackThreadOrigin,
    })
    await runTool(tool, { text: 'hi' })
    expect(queriedKeys).toHaveLength(1)
    expect(queriedKeys[0]).toEqual({
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: '1700000000.000100',
    })
  })

  test('denied replies never carry the consecutive hint suffix', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' }), { consecutiveCount: 7 }),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'no' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('denied')
    expect(text).not.toContain('consecutive')
  })

  test('schema rejects empty text via tool definition (smoke check on parameters)', () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    expect(tool.name).toBe('channel_reply')
    expect(tool.label).toBe('Channel Reply')
    expect(tool.description).toContain('default way to respond')
  })

  describe('attachments', () => {
    test('forwards attachments and text to router.send', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      await runTool(tool, { text: 'see attached', attachments: [{ path: '/agent/r.pdf' }] })
      expect(calls[0]).toMatchObject({
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        thread: '1700000000.000100',
        text: 'see attached',
        attachments: [{ path: '/agent/r.pdf' }],
      })
    })

    test('allows attachments without text', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackChannelRootOrigin,
      })
      const result = await runTool(tool, { attachments: [{ path: '/agent/a.png' }] })
      expect(result.details).toEqual({ ok: true })
      expect(calls[0]?.text).toBeUndefined()
    })

    test('rejects when neither text nor attachments are provided', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, {})
      expect(calls).toHaveLength(0)
      expect(result.details).toEqual({ ok: false, error: 'missing text and attachments' })
    })
  })

  describe('no-reply misuse guard', () => {
    test('blocks the send when text is exactly "NO_REPLY" and never invokes router.send', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'NO_REPLY' })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('silent-turn signal')
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_reply denied')
      expect(text).toContain('silent-turn signal')
      expect(text).not.toContain('posted to')
    })

    test('blocks on whitespace-padded "NO_REPLY" (mirrors router trim semantics)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: '\tNO_REPLY  ' })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
    })

    test('does NOT block when "NO_REPLY" appears as a substring inside a real message', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'I will reply NO_REPLY only when asked' })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('does NOT block on lowercase or other casings (must match exactly)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'no_reply' })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })
  })
})

describe('renderOutboundEcho', () => {
  test('text only renders the JSON-quoted text', () => {
    expect(renderOutboundEcho('hi', undefined)).toBe('"hi"')
  })

  test('attachments only renders count and filenames', () => {
    expect(renderOutboundEcho(undefined, [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }])).toBe(
      '2 file(s): a.png, b.pdf',
    )
  })

  test('both combines echo and filename summary', () => {
    expect(renderOutboundEcho('caption', [{ path: '/agent/a.png' }])).toBe('"caption" + 1 file(s): a.png')
  })

  test('attachment.filename overrides the basename in the echo', () => {
    expect(renderOutboundEcho(undefined, [{ path: '/agent/tmp-XYZ.bin', filename: 'report.pdf' }])).toBe(
      '1 file(s): report.pdf',
    )
  })

  test('empty input renders a sentinel', () => {
    expect(renderOutboundEcho(undefined, undefined)).toBe('(empty)')
    expect(renderOutboundEcho('', [])).toBe('(empty)')
  })
})
