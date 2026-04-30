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
  test('is a no-op for matching slack-bot targets (Slack has no public typing endpoint)', async () => {
    const infos: string[] = []
    const cb = createTypingCallback({
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null })
    expect(infos.some((m) => m.includes('typing (no-op)'))).toBe(true)
  })

  test('skips disallowed channels silently', async () => {
    const infos: string[] = []
    const cb = createTypingCallback({
      configRef: () => ({
        allow: ['team:T0OTHER'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null })
    expect(infos).toHaveLength(0)
  })

  test('rejects non-slack adapter without logging', async () => {
    const infos: string[] = []
    const cb = createTypingCallback({
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: '1', chat: '2', thread: null })
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
