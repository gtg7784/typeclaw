import { MEMBERSHIP_FRESHNESS_MS, type MembershipCount } from '@/channels/membership'
import type { AdapterId } from '@/channels/schema'

export type ChannelParticipant = {
  authorId: string
  authorName: string
  firstMessageAt: number
  lastMessageAt: number
  messageCount: number
  // Optional with default false so persisted records from prior versions
  // load cleanly. The solo-human engagement fallback in `decideEngagement`
  // counts only `!isBot` participants, so a missing flag must read as
  // human (current behavior) — never as bot (would silently disable the
  // fallback for legacy channels).
  isBot?: boolean
}

export type ChannelOriginContext = {
  lastInboundAuthorId?: string
  participants?: readonly ChannelParticipant[]
}

export type SessionOrigin =
  | { kind: 'tui'; sessionId: string }
  | {
      kind: 'cron'
      jobId: string
      jobKind: 'prompt' | 'exec' | 'subagent' | 'handler'
      scheduledByRole?: string
      scheduledByOrigin?: SessionOrigin | { kind: 'config-file' }
    }
  | {
      kind: 'channel'
      adapter: AdapterId
      workspace: string
      workspaceName?: string
      chat: string
      chatName?: string
      thread: string | null
      lastInboundAuthorId?: string
      participants?: readonly ChannelParticipant[]
      membership?: MembershipCount
    }
  | {
      kind: 'subagent'
      subagent: string
      parentSessionId: string
      spawnedByRole?: string
      spawnedByOrigin?: SessionOrigin
    }

export const PARTICIPANTS_TOP_K = 10
export const PARTICIPANTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Each adapter renders mentions differently and the model has to copy the
// exact shape to actually notify a peer. Until this table existed, the
// channel origin block hardcoded Discord syntax (`<@USER_ID>`) for every
// non-Slack adapter, which silently misled KakaoTalk and Telegram sessions
// into emitting addressing tokens that the platform doesn't recognise. The
// participants block kept rendering `<@authorId> (name)` lines for the
// same reason — see `renderParticipants`.
//
// `mentionMode` semantics:
//   - 'angle-id'     — Slack/Discord: `<@USER_ID>` where USER_ID is the
//                      raw `authorId` we already surface in participants.
//   - 'at-username'  — Telegram: `@username` plain text. The numeric
//                      `authorId` is NOT what gets mentioned; usernames are
//                      a separate field that not every user has.
//   - 'alias'        — KakaoTalk: type the bot's alias as plain text. The
//                      adapter's classifier (`kakaotalk-classify.ts`) does
//                      a substring match against configured aliases; there
//                      is no in-band syntax to copy.
type PlatformInfo = {
  displayName: string
  mentionMode: 'angle-id' | 'at-username' | 'alias'
}

const PLATFORM_INFO: Record<AdapterId, PlatformInfo> = {
  'slack-bot': { displayName: 'Slack', mentionMode: 'angle-id' },
  'discord-bot': { displayName: 'Discord', mentionMode: 'angle-id' },
  'telegram-bot': { displayName: 'Telegram', mentionMode: 'at-username' },
  kakaotalk: { displayName: 'KakaoTalk', mentionMode: 'alias' },
}

function getPlatformInfo(adapter: AdapterId): PlatformInfo {
  return PLATFORM_INFO[adapter]
}

// Compact description of the role the runtime resolved for this session at
// creation time. Rendered as a single block under the origin text for
// non-TUI sessions so the agent knows what it can and cannot do without
// having to call into the PermissionService itself. TUI is omitted because
// TUI is always `owner` by construction — annotating it would add noise to
// every interactive session for zero new information.
//
// For channel sessions this is a session-creation snapshot. The router
// re-resolves per-turn for tool gating, but the system prompt is not
// regenerated mid-session; the role line is accurate at admission and the
// `typeclaw-permissions` skill spells out how to interpret it on later
// turns when a different speaker may have spoken last.
export type SessionRoleContext = {
  role: string
  permissions: readonly string[]
}

export function renderSessionOrigin(
  origin: SessionOrigin,
  now: number = Date.now(),
  roleContext?: SessionRoleContext,
): string {
  switch (origin.kind) {
    case 'tui':
      return withRoleContext(renderTuiOrigin(), roleContext)
    case 'cron':
      return withRoleContext(renderCronOrigin(origin), roleContext)
    case 'channel':
      return withRoleContext(renderChannelOrigin(origin, now), roleContext)
    case 'subagent':
      return withRoleContext(renderSubagentOrigin(origin), roleContext)
  }
}

function withRoleContext(block: string, ctx: SessionRoleContext | undefined): string {
  if (ctx === undefined) return block
  return `${block}\n\n${renderRoleContext(ctx)}`
}

function renderRoleContext(ctx: SessionRoleContext): string {
  const permList = ctx.permissions.length === 0 ? 'none' : ctx.permissions.map((p) => `\`${p}\``).join(', ')
  return [
    '## Your role in this session',
    '',
    `Role: \`${ctx.role}\`. Permissions: ${permList}.`,
    '',
    'This is the role the runtime resolved at session creation. Tool calls',
    'and channel admission are gated by these permissions; a `blocked:` or',
    '"denied by permissions" message means the current actor lacks the',
    'permission the guard was looking for. See the `typeclaw-permissions`',
    'skill for what each role can do and how to grant access.',
  ].join('\n')
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

function renderCronOrigin(origin: { jobId: string; jobKind: 'prompt' | 'exec' | 'subagent' | 'handler' }): string {
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
    workspaceName?: string
    chat: string
    chatName?: string
    thread: string | null
    participants?: readonly ChannelParticipant[]
    membership?: MembershipCount
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
  const platformInfo = getPlatformInfo(origin.adapter)
  const lines: string[] = [
    '## Session origin',
    '',
    `You are responding inside a ${platformInfo.displayName} channel session. There is no human`,
    'attached to a console here — your only way to communicate with the user',
    'is a tool call. Plain-text output is invisible.',
  ]

  const conversationLine = renderConversationLine(origin)
  if (conversationLine !== null) lines.push('', conversationLine)

  lines.push(
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
    ...renderMentionGuidance(platformInfo, origin.participants ?? [], now),
  )

  const participantsBlock = renderParticipants(origin.participants ?? [], platformInfo, now)
  const membershipLine = renderMembershipSummary(origin, now)
  if (membershipLine !== null) lines.push('', membershipLine)
  if (participantsBlock) lines.push('', participantsBlock)

  lines.push('', 'Be concise; chat clients punish multi-paragraph replies.')
  return lines.join('\n')
}

function renderMembershipSummary(
  origin: { adapter: AdapterId; workspace: string; membership?: MembershipCount },
  now: number,
): string | null {
  const membership = origin.membership
  if (membership === undefined) return null

  const total = membership.humans + membership.bots
  const caveat =
    origin.adapter === 'discord-bot' && origin.workspace !== '@dm'
      ? ' (Note: this is the count of guild members; private channels with permission overwrites may have fewer actual viewers.)'
      : ''
  const isExact = !membership.truncated && now - membership.fetchedAt < MEMBERSHIP_FRESHNESS_MS
  if (isExact) {
    return `This channel has ${total} members: ${membership.humans} humans, ${membership.bots} bots.${caveat} The 10 most recent speakers are listed below.`
  }
  return `This channel has approximately ${total} members (about ${membership.humans} humans, ${membership.bots} bots — the bot count is approximate, the full member list was not enumerated because it exceeds the 50-member cap).${caveat} The 10 most recent speakers are listed below.`
}

function renderMentionGuidance(
  platformInfo: PlatformInfo,
  participants: readonly ChannelParticipant[],
  now: number,
): string[] {
  const cutoff = now - PARTICIPANTS_MAX_AGE_MS
  const fresh = [...participants]
    .filter((p) => p.lastMessageAt >= cutoff)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
  const peerBot = fresh.find((p) => p.isBot === true)
  const anyPeer = peerBot ?? fresh[0]
  const exampleId = anyPeer?.authorId ?? '123456789'
  const exampleName = anyPeer?.authorName ?? 'PeerBot'

  switch (platformInfo.mentionMode) {
    case 'angle-id':
      return [
        `To mention someone in your reply, use ${platformInfo.displayName} syntax \`<@USER_ID>\`.`,
        `For example, to address ${exampleName} in this conversation, write \`<@${exampleId}> hello\` —`,
        `**not** "${exampleName} hello". Plain-text names do not notify the recipient on ${platformInfo.displayName},`,
        'and other bots in this channel will not see the message as addressed to them.',
      ]
    case 'at-username':
      return [
        `To mention someone in your reply, use Telegram syntax \`@username\` in plain text.`,
        `Telegram usernames are a SEPARATE field from \`authorId\`. The \`<@id>\` tokens you see in the participants`,
        'block below are a typeclaw convention for parsing inbound mentions — do not echo them back as outbound mentions.',
        'If you only know an author by their display name and they have no `@username`, address them by display name',
        'and they will see the message via the reply context.',
      ]
    case 'alias':
      return [
        'KakaoTalk has no in-band mention syntax. To address someone, just type their display name as plain text;',
        "the participants block below shows display names. To get the BOT's attention from outside this session,",
        "a user types one of the bot's configured aliases — they do not need to copy any token from the participants list.",
        `The \`<@id>\` tokens in the participants block below are a typeclaw convention for parsing inbound mentions —`,
        'do not echo them back as outbound mentions; KakaoTalk would render them as literal text.',
      ]
  }
}

function renderConversationLine(origin: {
  adapter: AdapterId
  workspace: string
  workspaceName?: string
  chat: string
  chatName?: string
}): string | null {
  const hasChat = origin.chatName !== undefined && origin.chatName !== ''
  const hasWorkspace = origin.workspaceName !== undefined && origin.workspaceName !== ''
  if (!hasChat && !hasWorkspace) return null

  const chatPrefix = origin.adapter === 'slack-bot' ? '#' : ''
  const chatLabel = hasChat ? `**${chatPrefix}${origin.chatName!}** (${origin.chat})` : `\`${origin.chat}\``
  const workspaceLabel = hasWorkspace ? `**${origin.workspaceName!}** (${origin.workspace})` : `\`${origin.workspace}\``

  return `Conversation: ${chatLabel} in ${workspaceLabel}.`
}

function renderParticipants(
  participants: readonly ChannelParticipant[],
  platformInfo: PlatformInfo,
  now: number,
): string {
  const cutoff = now - PARTICIPANTS_MAX_AGE_MS
  const fresh = participants.filter((p) => p.lastMessageAt >= cutoff)
  if (fresh.length === 0) return ''

  const top = [...fresh].sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, PARTICIPANTS_TOP_K)

  const lines = ['## Recent participants (last 7 days, top 10 by recency)', '']
  for (const p of top) {
    const ago = formatAgo(now - p.lastMessageAt)
    const addressing = renderParticipantAddressing(p, platformInfo)
    lines.push(`- ${addressing} — last message: ${ago}, total: ${p.messageCount}`)
  }
  lines.push(
    '',
    'This list is **bounded** — it shows only the 10 most recently active',
    'authors in this conversation, all of whom have posted in the last 7',
    'days. Older or less recent authors are not shown even if they exist.',
    'This is **not** the full guild member list, and **not** an audit log',
    'of everyone who ever spoke here.',
    '',
    ...renderParticipantsTrailing(platformInfo),
  )
  return lines.join('\n')
}

// Per-line addressing token shown for each participant. The shape must match
// what the model will need to emit when addressing that participant, so the
// model can copy-paste the leading token verbatim. The previous unconditional
// `<@id> (name)` format trained the model toward angle-id syntax on every
// platform — correct for Discord/Slack, wrong for KakaoTalk (no in-band
// mention syntax) and Telegram (uses `@username`, where `authorId` is a
// numeric id and NOT the username). See issue #188.
//
// Symptom in the wild before PR #183 + this fix: 돌쇠 addressing Winky as
// "Winky님" (plain text) on Discord, which never trips Winky's `isBotMention`
// check, so Winky observes silently and the conversation stalls. The
// angle-id branch here is exactly the fix for that case; the at-username
// and alias branches keep the platform contract honest for KakaoTalk and
// Telegram instead of self-contradicting the per-adapter mention guidance
// produced by `renderMentionGuidance`.
function renderParticipantAddressing(p: ChannelParticipant, platformInfo: PlatformInfo): string {
  switch (platformInfo.mentionMode) {
    case 'angle-id':
      return `<@${p.authorId}> (${p.authorName})`
    case 'at-username':
    case 'alias':
      return `${p.authorName} (${p.authorId})`
  }
}

// Closing prose for the participants block. Mirrors the per-platform branch
// in `renderParticipantAddressing` so the trailing "address them" guidance
// matches the format the bullet points just demonstrated. The previous
// unconditional `<@authorId>` prose was the second voice in the
// self-contradiction noted in issue #188 — it told KakaoTalk/Telegram
// sessions to address peers with a syntax `renderMentionGuidance` had
// just told them not to use.
function renderParticipantsTrailing(platformInfo: PlatformInfo): string[] {
  switch (platformInfo.mentionMode) {
    case 'angle-id':
      return [
        "If a sender in the current turn isn't in the list, you can still",
        'address them — `<@authorId>` works for any author you have seen,',
        'even once. The list is a convenience for "who\'s been around lately,"',
        'not an exhaustive directory.',
      ]
    case 'at-username':
      return [
        "If a sender in the current turn isn't in the list, you can still",
        'address them by `@username` — Telegram usernames are a SEPARATE field',
        'from the numeric `authorId` shown in parentheses above, and not every',
        'user has one. The list is a convenience for "who\'s been around',
        'lately," not an exhaustive directory.',
      ]
    case 'alias':
      return [
        "If a sender in the current turn isn't in the list, you can still",
        'address them by display name as plain text — KakaoTalk has no in-band',
        'mention syntax, so the `authorId` shown in parentheses above is for',
        'your reference only and must not be echoed back. The list is a',
        'convenience for "who\'s been around lately," not an exhaustive directory.',
      ]
  }
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
