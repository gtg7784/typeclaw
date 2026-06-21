import { describe, expect, test } from 'bun:test'

import { originLabel, shortSessionId } from './label'

describe('originLabel', () => {
  test('TUI origin → "TUI"', () => {
    expect(originLabel({ kind: 'tui' })).toBe('TUI')
  })

  test('cron origin includes jobId and jobKind', () => {
    expect(originLabel({ kind: 'cron', jobId: 'daily-backup', jobKind: 'prompt' })).toBe('Cron daily-backup (prompt)')
  })

  test('subagent origin shows the subagent name without the redundant parent id', () => {
    expect(originLabel({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'ses_abcdef1234567890' })).toBe(
      'Subagent memory-logger',
    )
  })

  test('channel origin with names renders pretty platform/workspace/channel', () => {
    expect(
      originLabel({
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0123',
        workspaceName: 'Acme',
        chat: 'C0ABC',
        chatName: 'general',
        thread: null,
      }),
    ).toBe('Slack Acme/#general')
  })

  test('channel origin with discord adapter prefixes chat with # for chat names', () => {
    expect(
      originLabel({
        kind: 'channel',
        adapter: 'discord-bot',
        workspace: '9999',
        workspaceName: 'My Server',
        chat: '8888',
        chatName: 'dev-help',
        thread: null,
      }),
    ).toBe('Discord My Server/#dev-help')
  })

  test('channel origin without chat prefix adapters renders bare chat name (telegram)', () => {
    expect(
      originLabel({
        kind: 'channel',
        adapter: 'telegram-bot',
        workspace: 'tg-ws',
        workspaceName: 'My TG',
        chat: '42',
        chatName: 'Family',
        thread: null,
      }),
    ).toBe('Telegram My TG/Family')
  })

  test('channel origin without names falls back to bare IDs (legacy session files)', () => {
    expect(
      originLabel({
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0123',
        chat: 'C0ABC',
        thread: null,
      }),
    ).toBe('Slack T0123/C0ABC')
  })

  test('webex channel origin with a resolved room title renders it', () => {
    expect(
      originLabel({
        kind: 'channel',
        adapter: 'webex',
        workspace: '@dm',
        chat: 'Y2lzY29zcGFyazovL3VzL1JPT00vZTM1NGY2YjAtMmMyZS0xMWYxLTlmNGYtZmI5NzVmM2ViZWZi',
        chatName: 'Eng Standup',
        thread: null,
      }),
    ).toBe('Webex @dm/Eng Standup')
  })

  test('webex channel origin without a title decodes the base64 room id to its uuid ref', () => {
    expect(
      originLabel({
        kind: 'channel',
        adapter: 'webex-bot',
        workspace: '@dm',
        chat: 'Y2lzY29zcGFyazovL3VzL1JPT00vZTM1NGY2YjAtMmMyZS0xMWYxLTlmNGYtZmI5NzVmM2ViZWZi',
        thread: null,
      }),
    ).toBe('Webex @dm/e354f6b0-2c2e-11f1-9f4f-fb975f3ebefb')
  })

  test('channel origin with unknown adapter renders adapter id verbatim', () => {
    expect(
      originLabel({
        kind: 'channel',
        adapter: 'unknown-adapter',
        workspace: 'w',
        chat: 'c',
        thread: null,
      }),
    ).toBe('unknown-adapter w/c')
  })
})

describe('shortSessionId', () => {
  test('short ids pass through unchanged', () => {
    expect(shortSessionId('ses_abc')).toBe('ses_abc')
  })

  test('long ids truncate to 12 chars (no ellipsis — tabular output)', () => {
    expect(shortSessionId('ses_abcdef1234567890')).toBe('ses_abcdef12')
  })
})
