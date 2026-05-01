import { describe, expect, test } from 'bun:test'

import { isAllowed } from '@/channels/schema'

import type { SlackSocketAppMentionEvent } from './agent-messenger-slack-shim'
import { createTypingCallback, promoteAppMentionToMessage } from './slack-bot'
import { classifyInbound } from './slack-bot-classify'

describe('slack-bot adapter (unit-level pure helpers)', () => {
  test('isAllowed admits a team channel via team:T/C', () => {
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0ACME', 'C0DEPLOY')).toBe(true)
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0ACME', 'C0OTHER')).toBe(false)
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0WIDGET', 'C0DEPLOY')).toBe(false)
  })

  test('isAllowed admits all team channels via team:*', () => {
    expect(isAllowed(['team:*'], 'T0ACME', 'C0CHANNEL')).toBe(true)
    expect(isAllowed(['team:*'], '@dm', 'D0DMID')).toBe(false)
  })

  test('isAllowed admits Slack DMs only when the rule covers @dm', () => {
    expect(isAllowed(['team:*'], '@dm', 'D0DMID')).toBe(false)
    expect(isAllowed(['im:*'], '@dm', 'D0DMID')).toBe(true)
    expect(isAllowed(['*'], '@dm', 'D0DMID')).toBe(true)
  })

  test('isAllowed admits a Slack channel by id via channel:C', () => {
    expect(isAllowed(['channel:C0DEPLOY'], 'T0ACME', 'C0DEPLOY')).toBe(true)
    expect(isAllowed(['channel:C0DEPLOY'], 'T0WIDGET', 'C0DEPLOY')).toBe(true)
  })
})

describe('slack-bot createTypingCallback', () => {
  type SetStatusCall = { channel: string; threadTs: string; status: string }

  function makeFakeClient(behavior: 'ok' | 'reject' = 'ok'): {
    client: { setAssistantStatus: (channel: string, threadTs: string, status: string) => Promise<void> }
    calls: SetStatusCall[]
  } {
    const calls: SetStatusCall[] = []
    return {
      calls,
      client: {
        setAssistantStatus: async (channel, threadTs, status) => {
          calls.push({ channel, threadTs, status })
          if (behavior === 'reject') throw new Error('channel_not_found')
        },
      },
    }
  }

  test('calls setAssistantStatus with chat + thread when target is in a thread', async () => {
    // given
    const { client, calls } = makeFakeClient()
    const cb = createTypingCallback({
      client,
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: '1700000000.000100' })
    // then
    expect(calls).toEqual([{ channel: 'C0CHANNEL', threadTs: '1700000000.000100', status: 'is typing...' }])
  })

  test('is a no-op (logs info, no API call) for top-level chats without a thread', async () => {
    // given
    const { client, calls } = makeFakeClient()
    const infos: string[] = []
    const cb = createTypingCallback({
      client,
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null })
    // then
    expect(calls).toHaveLength(0)
    expect(infos.some((m) => m.includes('top-level chat'))).toBe(true)
  })

  test('warns (does not throw) when Slack rejects the API call', async () => {
    // given
    const { client, calls } = makeFakeClient('reject')
    const warns: string[] = []
    const cb = createTypingCallback({
      client,
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: '1700000000.000100' })
    // then
    expect(calls).toHaveLength(1)
    expect(warns.some((m) => m.includes('typing') && m.includes('channel_not_found'))).toBe(true)
  })

  test('skips disallowed channels silently (no API call, no log)', async () => {
    // given
    const { client, calls } = makeFakeClient()
    const infos: string[] = []
    const warns: string[] = []
    const cb = createTypingCallback({
      client,
      configRef: () => ({
        allow: ['team:T0OTHER'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      }),
      logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: '1700000000.000100' })
    // then
    expect(calls).toHaveLength(0)
    expect(infos).toHaveLength(0)
    expect(warns).toHaveLength(0)
  })

  test('rejects non-slack adapter without API call or logging', async () => {
    // given
    const { client, calls } = makeFakeClient()
    const infos: string[] = []
    const cb = createTypingCallback({
      client,
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'discord-bot', workspace: '1', chat: '2', thread: '3' })
    // then
    expect(calls).toHaveLength(0)
    expect(infos).toHaveLength(0)
  })
})

describe('slack-bot promoteAppMentionToMessage', () => {
  const baseAppMention: SlackSocketAppMentionEvent = {
    type: 'app_mention',
    channel: 'C0CHANNEL',
    user: 'UALICE',
    text: '<@UBOT> hi there',
    ts: '1700000000.000100',
  }

  test('produces a message-shaped event suitable for the classifier', () => {
    const promoted = promoteAppMentionToMessage(baseAppMention)

    expect(promoted.type).toBe('message')
    expect(promoted.channel).toBe('C0CHANNEL')
    expect(promoted.channel_type).toBe('channel')
    expect(promoted.user).toBe('UALICE')
    expect(promoted.text).toBe('<@UBOT> hi there')
    expect(promoted.ts).toBe('1700000000.000100')
  })

  test('preserves thread_ts when present so threaded mentions stay threaded', () => {
    const promoted = promoteAppMentionToMessage({ ...baseAppMention, thread_ts: '1699999999.000099' })

    expect(promoted.thread_ts).toBe('1699999999.000099')
  })

  test('promoted event classifies as a routed mention end-to-end', () => {
    const promoted = promoteAppMentionToMessage(baseAppMention)
    const verdict = classifyInbound(
      promoted,
      { allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true },
      { teamId: 'T0ACME', botUserId: 'UBOT' },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toMatchObject({
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      chat: 'C0CHANNEL',
      isBotMention: true,
      isDm: false,
    })
  })
})
