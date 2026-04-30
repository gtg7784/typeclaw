import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { OutboundMessage, SendResult } from '@/channels/types'

import { createChannelSendTool } from './channel-send'

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
    stop: async () => {},
    liveCount: () => 0,
  }
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelSendTool>['execute']>[4]

async function runTool(
  tool: ReturnType<typeof createChannelSendTool>,
  params: Parameters<ReturnType<typeof createChannelSendTool>['execute']>[1],
) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('createChannelSendTool', () => {
  test('forwards parameters to router.send and reports success', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelSendTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
    })
    const result = await runTool(tool, {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'hi',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'hi',
    })
    expect(result.details).toEqual({ ok: true })
  })

  test('forwards an optional thread when provided', async () => {
    const captured: { thread: string | null | undefined } = { thread: undefined }
    const tool = createChannelSendTool({
      router: fakeRouter(async (msg) => {
        captured.thread = msg.thread ?? null
        return { ok: true }
      }),
    })
    await runTool(tool, {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: 't42',
      text: 'in thread',
    })
    expect(captured.thread).toBe('t42')
  })

  test('reports denial back to the agent without throwing', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' })),
    })
    const result = await runTool(tool, {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c-blocked',
      text: 'nope',
    })
    expect(result.details).toEqual({ ok: false, error: 'denied by allow rules' })
    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('denied')
  })

  test('first send (count=1) returns the bare delivery confirmation', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 1 }),
    })
    const result = await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      text: 'first reply',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toBe('posted to slack-bot:T0/C0')
  })

  test('second consecutive send appends a soft yield hint', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 2 }),
    })
    const result = await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      text: 'continuing',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('posted to slack-bot:T0/C0')
    expect(text).toContain('2nd consecutive message')
    expect(text).toContain('continue only if')
  })

  test('third+ consecutive send appends a firm yield hint with the count', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 5 }),
    })
    const result = await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      text: 'still going',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('5th consecutive message')
    expect(text).toContain('end your turn now')
  })

  test('denied sends never carry the hint suffix', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' }), {
        consecutiveCount: 7,
      }),
    })
    const result = await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C-blocked',
      text: 'no',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('denied')
    expect(text).not.toContain('consecutive')
  })

  describe('thread-mismatch hint', () => {
    test('warns when posting to the same conversation as origin but dropping the thread', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'oops' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('posted to slack-bot:T0/C0')
      expect(text).toContain('origin thread is "1700000000.000100"')
      expect(text).toContain('channel root')
      expect(text).toContain('channel_reply')
    })

    test('does NOT warn when the model passes the matching thread explicitly', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        thread: '1700000000.000100',
        text: 'in thread',
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toBe('posted to slack-bot:T0/C0')
    })

    test('does NOT warn when the model deliberately posts to a DIFFERENT chat', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C-other',
        text: 'cross-channel post',
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toBe('posted to slack-bot:T0/C-other')
    })

    test('does NOT warn when the origin had no thread to begin with (channel-root origin)', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null },
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: 'channel-root reply',
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toBe('posted to slack-bot:T0/C0')
    })

    test('does NOT warn when no origin is supplied (cron / non-channel session)', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'cron post' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toBe('posted to slack-bot:T0/C0')
    })

    test('does NOT warn on adapter mismatch (cross-platform post)', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'd1',
        text: 'cross-platform',
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toBe('posted to discord-bot:g1/d1')
    })

    test('combines with the consecutive-send hint when both fire', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 2 }),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'oops twice' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('posted to slack-bot:T0/C0')
      expect(text).toContain('2nd consecutive message')
      expect(text).toContain('origin thread is "1700000000.000100"')
    })

    test('does not fire on a denied send even when addressing matches', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: false, error: 'denied' })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'no' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('denied')
      expect(text).not.toContain('origin thread')
    })
  })
})
