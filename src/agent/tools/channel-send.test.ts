import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { OutboundMessage, SendResult } from '@/channels/types'

import { createChannelSendTool } from './channel-send'

function fakeRouter(handler: (msg: OutboundMessage) => Promise<SendResult>): ChannelRouter {
  return {
    route: async () => {},
    send: handler,
    registerOutbound: () => {},
    unregisterOutbound: () => {},
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
})
