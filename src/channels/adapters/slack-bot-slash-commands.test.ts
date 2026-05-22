import { describe, expect, test } from 'bun:test'

import type { SlackSocketModeSlashCommandArgs } from 'agent-messenger/slackbot'

import { buildSlashAckPayload, parseSlashCommand } from './slack-bot-slash-commands'

type Body = SlackSocketModeSlashCommandArgs['body']

function body(over: Partial<Body> = {}): Body {
  return {
    command: '/stop',
    text: '',
    user_id: 'U-alice',
    channel_id: 'C-general',
    team_id: 'T-acme',
    ...over,
  }
}

describe('parseSlashCommand', () => {
  const known = new Set(['stop'])

  test('parses /stop in a public channel into a slack-bot ChannelKey', () => {
    const result = parseSlashCommand(body(), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command).toEqual({
      name: 'stop',
      key: { adapter: 'slack-bot', workspace: 'T-acme', chat: 'C-general', thread: null },
      invokerId: 'U-alice',
    })
  })

  test('maps DM channel ids (D prefix) to workspace=@dm', () => {
    const result = parseSlashCommand(body({ channel_id: 'D-bob' }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.key.workspace).toBe('@dm')
    expect(result.command.key.chat).toBe('D-bob')
  })

  test('private channel ids (G prefix) map to the team workspace (NOT @dm)', () => {
    const result = parseSlashCommand(body({ channel_id: 'G-secret' }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.key.workspace).toBe('T-acme')
    expect(result.command.key.chat).toBe('G-secret')
  })

  test('lowercases the command name', () => {
    const result = parseSlashCommand(body({ command: '/STOP' }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.name).toBe('stop')
  })

  test('ignores unknown command names', () => {
    const result = parseSlashCommand(body({ command: '/unknown' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'unknown-command' })
  })

  test('ignores malformed commands (no leading slash)', () => {
    const result = parseSlashCommand(body({ command: 'stop' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'malformed' })
  })

  test('ignores payloads missing user_id (defensive)', () => {
    const result = parseSlashCommand(body({ user_id: '' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'no-invoker' })
  })

  test('ignores payloads missing channel_id', () => {
    const result = parseSlashCommand(body({ channel_id: '' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'no-channel' })
  })

  test('ignores payloads missing team_id (defensive — slash commands always carry it)', () => {
    const result = parseSlashCommand(body({ team_id: '' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'no-team' })
  })

  test('always sets thread:null (Slack slash commands cannot be invoked from a thread)', () => {
    const result = parseSlashCommand(body(), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.key.thread).toBe(null)
  })
})

describe('buildSlashAckPayload', () => {
  test('returns an ephemeral response payload', () => {
    expect(buildSlashAckPayload('Stopped.')).toEqual({
      response_type: 'ephemeral',
      text: 'Stopped.',
    })
  })
})
