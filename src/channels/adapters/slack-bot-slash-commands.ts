import type { SlackSocketModeSlashCommandArgs } from 'agent-messenger/slackbot'

import type { ChannelKey } from '@/channels/types'

// Slack channel ids: 'C' = public, 'G' = private/legacy multi-party DM,
// 'D' = direct message. Slash-command payloads don't carry `channel_type`,
// so we read the id prefix directly. The slack-bot inbound classifier uses
// `event.channel_type === 'im'` for the same purpose, but that field isn't
// in the slash-command body. Group DMs ('G' prefix) are NOT treated as DMs
// here — they map to `workspace: team_id` like a regular channel, matching
// how the inbound classifier handles MPIM messages (channel_type 'mpim'
// is not 'im' and therefore falls through to the team workspace branch).
const SLACK_DM_CHANNEL_PREFIXES: readonly string[] = ['D']

export type ParsedSlackSlashCommand = {
  name: string
  key: ChannelKey
  invokerId: string
}

export type ParseSlashCommandResult =
  | { kind: 'parsed'; command: ParsedSlackSlashCommand }
  | { kind: 'ignore'; reason: 'unknown-command' | 'no-invoker' | 'no-channel' | 'no-team' | 'malformed' }

export function parseSlashCommand(
  body: SlackSocketModeSlashCommandArgs['body'],
  knownCommands: ReadonlySet<string>,
): ParseSlashCommandResult {
  if (typeof body.command !== 'string' || !body.command.startsWith('/')) {
    return { kind: 'ignore', reason: 'malformed' }
  }
  const name = body.command.slice(1).toLowerCase()
  if (name === '' || !knownCommands.has(name)) {
    return { kind: 'ignore', reason: 'unknown-command' }
  }
  if (typeof body.user_id !== 'string' || body.user_id === '') {
    return { kind: 'ignore', reason: 'no-invoker' }
  }
  if (typeof body.channel_id !== 'string' || body.channel_id === '') {
    return { kind: 'ignore', reason: 'no-channel' }
  }
  // team_id is required for slash commands per Slack's API, but defensively
  // refuse to construct a ChannelKey without it — otherwise the workspace
  // field would collide with a real workspace id named '' downstream.
  if (typeof body.team_id !== 'string' || body.team_id === '') {
    return { kind: 'ignore', reason: 'no-team' }
  }

  const isDm = SLACK_DM_CHANNEL_PREFIXES.some((prefix) => body.channel_id.startsWith(prefix))
  const workspace = isDm ? '@dm' : body.team_id

  return {
    kind: 'parsed',
    command: {
      name,
      // thread is null because Slack slash commands cannot be invoked from
      // inside a thread — Slack's compose box always targets the top-level
      // channel. The router's executeCommand falls back to any live session
      // in the same workspace+chat when an exact key match misses, so a
      // thread-keyed live session still gets hit by a thread-less slash.
      key: { adapter: 'slack-bot', workspace, chat: body.channel_id, thread: null },
      invokerId: body.user_id,
    },
  }
}

export const SLACK_SLASH_REPLY_ABORTED = 'Stopped the current turn.'
export const SLACK_SLASH_REPLY_NO_LIVE_SESSION = 'Nothing to stop — no active turn in this channel.'
export const SLACK_SLASH_REPLY_FAILED = 'Could not stop the current turn (internal error).'
export const SLACK_SLASH_REPLY_PERMISSION_DENIED =
  'You do not have permission to stop the current turn in this channel.'
export const SLACK_SLASH_REPLY_AMBIGUOUS =
  'Multiple active turns in this channel. Reply `/stop` from inside the specific thread you want to stop.'

// Slack's ack callback accepts an optional response payload that becomes
// the user-visible reply. `response_type: 'ephemeral'` keeps the reply
// visible only to the invoker (vs. 'in_channel' which posts to everyone).
// Control gestures should stay ephemeral — same rationale as Discord's
// EPHEMERAL flag on interaction callbacks.
export function buildSlashAckPayload(text: string): { response_type: 'ephemeral'; text: string } {
  return { response_type: 'ephemeral', text }
}
