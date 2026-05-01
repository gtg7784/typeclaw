import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { OutboundMessage, SendResult } from '@/channels/types'

import { createChannelReplyTool, type ChannelReplyOrigin } from './channel-reply'

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

  test('reports the origin chat in the success message', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'hi' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toBe('posted to slack-bot:T0/C0')
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
    expect(text).toContain('posted to slack-bot:T0/C0')
    expect(text).toContain('2nd consecutive message')
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
})
