import type { AdapterId } from '@/channels/schema'

export type ChannelParticipant = {
  authorId: string
  authorName: string
  firstMessageAt: number
  lastMessageAt: number
  messageCount: number
}

export type ChannelOriginContext = {
  lastInboundAuthorId?: string
  participants?: readonly ChannelParticipant[]
}

export type SessionOrigin =
  | { kind: 'tui'; sessionId: string }
  | { kind: 'cron'; jobId: string; jobKind: 'prompt' | 'exec' | 'subagent' }
  | {
      kind: 'channel'
      adapter: AdapterId
      workspace: string
      chat: string
      thread: string | null
      lastInboundAuthorId?: string
      participants?: readonly ChannelParticipant[]
    }
  | { kind: 'subagent'; subagent: string; parentSessionId: string }

export const PARTICIPANTS_TOP_K = 10
export const PARTICIPANTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function renderSessionOrigin(origin: SessionOrigin, now: number = Date.now()): string {
  switch (origin.kind) {
    case 'tui':
      return renderTuiOrigin()
    case 'cron':
      return renderCronOrigin(origin)
    case 'channel':
      return renderChannelOrigin(origin, now)
    case 'subagent':
      return renderSubagentOrigin(origin)
  }
}

function renderTuiOrigin(): string {
  return [
    '## Session origin',
    '',
    'You are running in the TUI session that the operator is currently',
    'attached to. Verbose explanations are welcome. The operator can see',
    'your tool calls and outputs in real time.',
  ].join('\n')
}

function renderCronOrigin(origin: { jobId: string; jobKind: 'prompt' | 'exec' | 'subagent' }): string {
  return [
    '## Session origin',
    '',
    'You are running an unattended cron job.',
    '',
    `- Job ID:   \`${origin.jobId}\``,
    `- Job kind: ${origin.jobKind}`,
    '',
    'No human is watching this turn. Produce side effects (e.g. via',
    '`channel_send`) where appropriate. Do not ask clarifying questions —',
    "the prompt has everything you should need. If you can't proceed, log",
    'your blockers and exit.',
  ].join('\n')
}

function renderSubagentOrigin(origin: { subagent: string; parentSessionId: string }): string {
  return [
    '## Session origin',
    '',
    `You are a \`${origin.subagent}\` subagent spawned by parent session`,
    `\`${origin.parentSessionId}\`. Stay narrowly within the task you were given.`,
    'Return cleanly when done; do not sprawl into unrelated work.',
  ].join('\n')
}

function renderChannelOrigin(
  origin: {
    adapter: AdapterId
    workspace: string
    chat: string
    thread: string | null
    participants?: readonly ChannelParticipant[]
  },
  now: number,
): string {
  // The OBLIGATION-not-permission framing here exists because Kimi K2.5 Turbo
  // (and likely other models) will otherwise treat short / casual messages as
  // "ambient observation" and emit no tool call. Plain-text output from the
  // agent in a channel session is dead text — there is no human attached to
  // a stdout to read it. The only way to talk to the user is the tool. Making
  // that obligation crisp and pre-filling the addressing fields removed a
  // class of "model finishes silently, no reply ever lands" failures that we
  // could only see in the logs as `prompted` followed by no `outbound`.
  //
  // The original wording told the model to call channel_send and copy
  // adapter/workspace/chat/thread verbatim. Models still routinely dropped
  // `thread`, so the same conversation got bisected into a fresh top-level
  // thread on Slack. channel_reply now exists for that reason: it takes
  // only `text` and pulls addressing from this origin. We point the model at
  // it as the default, and keep channel_send as the escape hatch for posting
  // elsewhere (different chat, breaking out of the thread on purpose, etc.).
  const platform = origin.adapter === 'slack-bot' ? 'Slack' : 'Discord'
  const lines: string[] = [
    '## Session origin',
    '',
    `You are responding inside a ${platform} channel session. There is no human`,
    'attached to a console here — your only way to communicate with the user',
    'is a tool call. Plain-text output is invisible.',
    '',
    '**For every user message in this session, you MUST call `channel_reply`',
    '(or `channel_send`) at least once before ending your turn**, unless the',
    'user explicitly told you to stay silent. If you intentionally do not',
    'reply, your entire final visible response must be exactly `NO_REPLY`.',
    'Any other visible text without a channel tool call is blocked.',
    '',
    'To reply in this conversation, call `channel_reply({ text })`. Addressing',
    `is filled in from this session, including the thread${origin.thread !== null ? '' : ' (none here — this is a channel-root session)'}, so you don't`,
    'need to copy any of these fields:',
    '',
    '```json',
    '{',
    `  "adapter": ${JSON.stringify(origin.adapter)},`,
    `  "workspace": ${JSON.stringify(origin.workspace)},`,
    `  "chat": ${JSON.stringify(origin.chat)},`,
    origin.thread !== null ? `  "thread": ${JSON.stringify(origin.thread)}` : '  "thread": null',
    '}',
    '```',
    '',
    'To post somewhere else (different chat, break out of the current',
    'thread on purpose, send a DM from this channel session, etc.), use',
    '`channel_send` and pass the addressing fields explicitly. Only chats',
    "matching the channel's `allow` rules are accepted (the tool returns",
    '`{ ok: false }` otherwise).',
    '',
    `To mention someone in your reply, use ${platform} syntax \`<@USER_ID>\`.`,
  ]

  const participantsBlock = renderParticipants(origin.participants ?? [], now)
  if (participantsBlock) lines.push('', participantsBlock)

  lines.push('', 'Be concise; chat clients punish multi-paragraph replies.')
  return lines.join('\n')
}

function renderParticipants(participants: readonly ChannelParticipant[], now: number): string {
  const cutoff = now - PARTICIPANTS_MAX_AGE_MS
  const fresh = participants.filter((p) => p.lastMessageAt >= cutoff)
  if (fresh.length === 0) return ''

  const top = [...fresh].sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, PARTICIPANTS_TOP_K)

  const lines = ['## Recent participants (last 7 days, top 10 by recency)', '']
  for (const p of top) {
    const ago = formatAgo(now - p.lastMessageAt)
    lines.push(`- ${p.authorName}  (id: ${p.authorId}) — last message: ${ago}, total: ${p.messageCount}`)
  }
  lines.push(
    '',
    'This list is **bounded** — it shows only the 10 most recently active',
    'authors in this conversation, all of whom have posted in the last 7',
    'days. Older or less recent authors are not shown even if they exist.',
    'This is **not** the full guild member list, and **not** an audit log',
    'of everyone who ever spoke here.',
    '',
    "If a sender in the current turn isn't in the list, you can still",
    "address them — `<@authorId>` works for any author you've seen, even",
    'once. The list is a convenience for "who\'s been around lately,"',
    'not an exhaustive directory.',
  )
  return lines.join('\n')
}

function formatAgo(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} seconds ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const days = Math.round(hr / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
