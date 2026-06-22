import { describe, expect, test } from 'bun:test'

import { channelsSchema } from '@/channels/schema'

import { classifyInbound, type WebexInboundMessage } from './webex-bot-classify'

const config = channelsSchema.parse({ 'webex-bot': {} })['webex-bot']!

function message(overrides: Partial<WebexInboundMessage> = {}): WebexInboundMessage {
  return {
    id: 'msg-1',
    ref: 'msg-1',
    roomId: 'room-1',
    roomRef: 'room-1',
    personId: 'user-1',
    personRef: 'user-1',
    personEmail: 'user@example.com',
    text: 'hello',
    created: '2026-01-01T00:00:00.000Z',
    roomType: 'group',
    mentionedPeople: [],
    mentionedPeopleRefs: [],
    mentionedGroups: [],
    files: [],
    raw: {} as WebexInboundMessage['raw'],
    ...overrides,
  }
}

describe('classifyInbound', () => {
  test('drops self-authored messages', () => {
    expect(classifyInbound(message({ personId: 'bot-blob', personRef: 'bot-1' }), config, 'bot-1')).toEqual({
      kind: 'drop',
      reason: 'self_author',
    })
  })

  test('drops self-authored messages by email when personRef desyncs from the bot ref', () => {
    expect(
      classifyInbound(
        message({ personRef: 'uuid-from-mercury', personEmail: 'typeey@typeclaw.dev' }),
        config,
        'legacy-email-ref',
        [],
        'typeey@typeclaw.dev',
      ),
    ).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('self-email match is case-insensitive', () => {
    expect(
      classifyInbound(
        message({ personRef: 'uuid-from-mercury', personEmail: 'TypeEy@TypeClaw.DEV' }),
        config,
        'legacy-email-ref',
        [],
        'typeey@typeclaw.dev',
      ),
    ).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops empty messages without files', () => {
    expect(classifyInbound(message({ text: '' }), config, 'bot-1')).toEqual({ kind: 'drop', reason: 'empty_content' })
  })

  test('drops before bot identity is known', () => {
    expect(classifyInbound(message(), config, null)).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('routes structured bot and group mentions without parsing the Korean body', () => {
    const verdict = classifyInbound(
      message({
        text: '확인 부탁해요',
        mentionedPeople: ['bot-blob'],
        mentionedPeopleRefs: ['bot-1'],
        mentionedGroups: ['all'],
      }),
      config,
      'bot-1',
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
    expect(verdict.payload.text).toBe('확인 부탁해요')
  })

  test('marks alias-only messages as bot mentions', () => {
    const verdict = classifyInbound(message({ text: '타이피야 확인해줘' }), config, 'bot-1', ['타이피', 'typeey'])

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.replyToBotMessageId).toBeNull()
  })

  test('marks mentionsOthers when only another person is mentioned', () => {
    const verdict = classifyInbound(
      message({ mentionedPeople: ['user-2-blob'], mentionedPeopleRefs: ['user-2'] }),
      config,
      'bot-1',
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.mentionsOthers).toBe(true)
  })

  test('maps direct rooms to @dm and renders file attachments', () => {
    const verdict = classifyInbound(
      message({ roomType: 'direct', files: ['https://files.webexcontent.com/path/report.pdf'] }),
      config,
      'bot-1',
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.workspace).toBe('@dm')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'https://files.webexcontent.com/path/report.pdf', filename: 'report.pdf' },
    ])
    expect(verdict.payload.text).toContain('Webex attachment #1')
  })
})
