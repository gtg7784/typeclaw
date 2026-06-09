import { MEMBERSHIP_FRESHNESS_MS, type MembershipCount } from '@/channels/membership'
import type { AdapterId } from '@/channels/schema'
import type { ChannelSelfIdentity, ReactionRef } from '@/channels/types'

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
      reactionRef?: ReactionRef
      participants?: readonly ChannelParticipant[]
      membership?: MembershipCount
      self?: ChannelSelfIdentity
    }
  | {
      kind: 'subagent'
      subagent: string
      parentSessionId: string
      spawnedByRole?: string
      spawnedByOrigin?: SessionOrigin
    }
  // Runtime-owned infrastructure operating over TypeClaw's own state (memory
  // logging/retrieval, backup), NOT user-delegated work. It resolves to `owner`
  // because it acts on the operator's behalf over operator-owned files, with no
  // single user session to inherit authority from — inheriting the triggering
  // turn's role (e.g. a guest channel turn) would wrongly classify TypeClaw
  // infrastructure as the guest actor and block its legitimate sessions//memory/
  // access. `triggeredBy` keeps honest provenance — "a guest turn triggered the
  // memory-logger" — without the synthetic-TUI lie. This kind is only ever
  // constructed by runtime/bundled code; inbound channel/cron content can never
  // produce it (those origins come from the runtime, not from message text), so
  // it is not a role-laundering vector.
  | {
      kind: 'system'
      component: string
      reason?: string
      triggeredBy?: SessionOrigin
    }

// Hard ceiling on the subagent delegation chain. Bounds chain LENGTH, not
// fan-out breadth: the deepest reachable chain is main (depth 0) →
// operator/reviewer (depth 1) → nested worker (depth 2). `spawn_subagent`
// refuses to spawn from a session already at this depth.
export const MAX_SUBAGENT_DEPTH = 2

// Counts subagent links from the root by walking the `spawnedByOrigin`
// ancestry. A non-subagent (or undefined) origin is depth 0; each nested
// subagent origin adds one. Fails CLOSED on ambiguous ancestry: if a subagent
// origin has no `spawnedByOrigin` (the serialized path in
// parseSpawnedByOriginJson drops it), the true depth is unknowable, so we
// return MAX_SUBAGENT_DEPTH rather than assume it sits at the root — a
// truncated grandchild must not read as a child and earn an extra spawn. A
// cyclic chain is bounded by the same cap.
export function subagentDepth(origin: SessionOrigin | undefined): number {
  let depth = 0
  let current: SessionOrigin | undefined = origin
  while (current !== undefined && current.kind === 'subagent') {
    depth += 1
    if (current.spawnedByOrigin === undefined) {
      return MAX_SUBAGENT_DEPTH
    }
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return depth
    }
    current = current.spawnedByOrigin
  }
  return depth
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
  // Whether this adapter registers a ReactionCallback, i.e. whether
  // `channel_react` actually does anything here. Gates the proactive-reaction
  // prompt guidance so we never tell a KakaoTalk/Telegram agent to react when
  // the call would no-op. Keep in sync with the adapters that call
  // `router.registerReaction` (github, slack-bot, discord-bot today).
  supportsReactions: boolean
  // Whether this adapter's OutboundCallback accepts file attachments. Gates the
  // "ship a researcher report as a PDF by default" prompt guidance: a report is
  // only worth converting to a downloadable file on channels that can actually
  // receive one. GitHub's outbound callback hard-rejects attachments
  // (`github-bot-does-not-support-attachments` in adapters/github/outbound.ts),
  // so a PDF nudge there would train the model toward a call that always fails;
  // the other four upload files (Slack `uploadFile`, Discord `uploadFile`,
  // Telegram `sendDocument`, KakaoTalk `sendAttachment`). Keep in sync with the
  // adapters' outbound callbacks.
  supportsAttachments: boolean
}

const PLATFORM_INFO: Record<AdapterId, PlatformInfo> = {
  'slack-bot': { displayName: 'Slack', mentionMode: 'angle-id', supportsReactions: true, supportsAttachments: true },
  'discord-bot': {
    displayName: 'Discord',
    mentionMode: 'angle-id',
    supportsReactions: true,
    supportsAttachments: true,
  },
  github: { displayName: 'GitHub', mentionMode: 'at-username', supportsReactions: true, supportsAttachments: false },
  'telegram-bot': {
    displayName: 'Telegram',
    mentionMode: 'at-username',
    supportsReactions: false,
    supportsAttachments: true,
  },
  line: { displayName: 'LINE', mentionMode: 'alias', supportsReactions: false, supportsAttachments: false },
  kakaotalk: { displayName: 'KakaoTalk', mentionMode: 'alias', supportsReactions: false, supportsAttachments: true },
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
// Channel origins do NOT render this concrete role. A channel session is
// keyed by chat/thread, so the opener's role is wrong for every later
// speaker and printing their permission list leaks it into shared context.
// Channel origins render renderChannelRolePolicy() instead, and the
// authoritative per-turn role rides in the non-cacheable `<your-role>`
// turn anchor (renderTurnRoleAnchor in system-prompt.ts).
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
      return withRoleContext(renderTuiOrigin(), roleContext, origin.kind)
    case 'cron':
      return withRoleContext(renderCronOrigin(origin), roleContext, origin.kind)
    case 'channel':
      return withRoleContext(renderChannelOrigin(origin, now), roleContext, origin.kind)
    case 'subagent':
      return withRoleContext(renderSubagentOrigin(origin), roleContext, origin.kind)
    case 'system':
      return withRoleContext(renderSystemOrigin(origin), roleContext, origin.kind)
  }
}

function withRoleContext(block: string, ctx: SessionRoleContext | undefined, kind: SessionOrigin['kind']): string {
  if (ctx === undefined) return block
  const roleBlock = kind === 'channel' ? renderChannelRolePolicy() : renderRoleContext(ctx)
  return `${block}\n\n${roleBlock}`
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

// Channel sessions are keyed by chat/thread, not by author: one session can see
// many speakers with different roles. Rendering the opener's concrete role here
// would (1) be wrong for every later speaker and (2) leak the opener's full
// permission list into shared context. So channel origins get a cache-stable
// policy instead of a resolved identity; the authoritative per-turn role rides
// in the non-cacheable `<your-role>` turn anchor.
function renderChannelRolePolicy(): string {
  return [
    '## Your role in this session',
    '',
    'This is a channel conversation that may include multiple speakers. Do not',
    'assume one speaker’s role applies to later messages. For each user turn the',
    'current speaker’s effective role is provided in the turn context as a',
    '`<your-role>` tag; that per-turn role is authoritative for the current',
    'message and overrides any role implied by session-opening context. An absent',
    '`<your-role>` tag means the current speaker is the unconstrained default.',
    '',
    'Tool calls and channel admission are gated by the current speaker’s',
    'permissions; a `blocked:` or "denied by permissions" message means that',
    'speaker lacks the permission the guard wanted. See the',
    '`typeclaw-permissions` skill for what each role can do.',
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

function renderSystemOrigin(origin: { component: string; reason?: string; triggeredBy?: SessionOrigin }): string {
  const lines = [
    '## Session origin',
    '',
    `You are the \`${origin.component}\` system process — TypeClaw-owned`,
    "infrastructure operating over the agent folder on the operator's behalf,",
    'not a user-delegated task. Do exactly the job described and exit.',
  ]
  if (origin.reason !== undefined) lines.push('', `Reason: ${origin.reason}`)
  if (origin.triggeredBy !== undefined) lines.push('', `Triggered by: ${describeTrigger(origin.triggeredBy)}`)
  return lines.join('\n')
}

function describeTrigger(origin: SessionOrigin): string {
  switch (origin.kind) {
    case 'tui':
      return 'a TUI session'
    case 'cron':
      return `cron job \`${origin.jobId}\``
    case 'channel':
      return `a ${getPlatformInfo(origin.adapter).displayName} channel turn`
    case 'subagent':
      return `the \`${origin.subagent}\` subagent`
    case 'system':
      return `the \`${origin.component}\` system process`
  }
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
    reactionRef?: ReactionRef
    participants?: readonly ChannelParticipant[]
    membership?: MembershipCount
    self?: ChannelSelfIdentity
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

  // GitHub has no separate "chat" surface — channel_reply IS a public comment
  // on this PR/issue. Without saying so, models default to the Slack-style
  // two-surface split and post operator-facing meta-commentary ("Posted review
  // result for PR #511") straight into the PR thread, where it reads absurdly.
  if (origin.adapter === 'github') {
    lines.push(
      '',
      '**`channel_reply` posts a public comment directly on this PR/issue.** It',
      'is not a side-report to an operator — the reply lands in this exact',
      'thread, read by everyone on the PR. Write the substance for that',
      'audience: post the answer (or review summary) itself, never a status',
      'line about having posted it elsewhere. A narrated "Posted review result',
      'for PR #N: …" inside the PR is exactly the failure to avoid.',
      '',
      '**Do not post an "On it" acknowledgment comment.** The runtime already',
      'adds an :eyes: reaction to the triggering item the moment it engages, so a',
      'separate "looking into this" comment is redundant noise on the PR. If you',
      'want to signal acknowledgment explicitly, use `channel_react({ emoji })`',
      '(it reacts, it does not comment) — never a text ack. Reserve `channel_reply`',
      'for the actual substantive answer.',
    )
  }

  const conversationLine = renderConversationLine(origin)
  if (conversationLine !== null) lines.push('', conversationLine)

  // Gate on `reactionRef`, not just the static `supportsReactions` platform
  // fact: a turn only has a message to react to when the triggering inbound
  // carried one. Reminder-only turns (restart-resume, subagent-completion,
  // idle/todo continuation) wake the session with no inbound, so
  // `buildLiveOrigin` omits `reactionRef`. Prompting "react like a teammate"
  // there made the model call `channel_react`, which then denied with "this
  // conversation has no message to react to".
  if (platformInfo.supportsReactions && origin.reactionRef !== undefined) {
    lines.push(
      '',
      '**React like a teammate would.** You can drop an emoji on the message that',
      'triggered this turn with `channel_react({ emoji })` — it posts no comment,',
      'just a reaction. Read the message and pick what genuinely fits its tone:',
      '`+1` to agree or approve, `rocket` for something shipping or exciting,',
      '`tada` to celebrate, `heart` to show appreciation, `laugh` for something',
      'funny, `eyes` to signal you are looking. Reach for it when a reaction adds',
      'real warmth or signal — not on every message, and not just because you can.',
      'A reaction does NOT satisfy the reply obligation below: when the message',
      'needs a substantive answer, still send it via `channel_reply`. Think of',
      'reactions as the lightweight, human layer on top of your words, not a',
      'replacement for them.',
    )
  }

  lines.push(
    '',
    '**For every user message in this session, you MUST call `channel_reply`',
    '(or `channel_send`) at least once before ending your turn**, unless the',
    'user explicitly told you to stay silent or you have nothing genuinely',
    'new to add. When you intentionally do not reply, prefer the structured',
    'silent-turn tool over leaking your decision into visible text:',
    '',
    '- **`skip_response({ reason })`** — preferred. Records a short reason',
    '  to host logs (visible via `typeclaw logs -f`) and suppresses the',
    '  channel reply for this turn. The user sees nothing; the operator',
    '  sees why. Use this whenever you have a reason worth recording',
    '  ("no new info beyond previous reply", "user asked me to stay',
    '  silent", "subagent result duplicates what I already sent", etc.).',
    '  The contract is bidirectional: after calling `skip_response`, any',
    '  `channel_reply`/`channel_send` in the same turn will be rejected,',
    '  AND calling `skip_response` after a reply has already landed in',
    '  this turn will also be rejected. Commit to silence or commit to',
    '  replying, not both. Do not include secrets or long reasoning in',
    '  the reason; keep it under one sentence.',
    '- **`NO_REPLY` text sentinel** — fallback. End your turn with',
    '  exactly `NO_REPLY` as your visible response and no channel tool',
    '  call. Use this only when `skip_response` is unavailable or you',
    '  have no reason worth recording. Any other visible text without a',
    '  channel tool call is blocked.',
    '',
    'Both of the above silence only the CURRENT turn. To stop being pulled',
    'back into FUTURE turns, use the engagement tool below.',
    '',
    '- **`channel_disengage()`** — drop "mid-conversation" stickiness for this',
    '  conversation. After you reply to someone, their next message re-engages',
    '  you without an @mention, and that is renewed on every reply — so in a',
    '  busy group you can get stuck answering turn after turn even after being',
    '  told to stop. Call this when a human or peer bot asks you to be quiet /',
    '  stop replying, or when you notice you are in a redundant loop. After',
    '  disengaging you only re-engage when explicitly addressed again (mention,',
    '  reply, or DM). It sends no message and does not affect other channels.',
    '  ORDER MATTERS: if you want to ack ("ok, backing off") before going quiet,',
    "  send that `channel_reply` FIRST, THEN call `channel_disengage` — it's the",
    '  natural terminal action for the turn. Pair it with `skip_response` when',
    '  you also want to stay silent this turn.',
    '',
    '  **An explicit quiet command is a direct order to call this tool.** When',
    '  someone tells you to stop — e.g. "disengage", "be quiet", "stop replying",',
    '  "stop", "back off", "stay out of this", "shush", or "조용" / "조용히 해" /',
    '  "그만" / "빠져" / "static" / "tais-toi" / "cállate" / "ruhig" / "黙って" /',
    '  "安静" in any language — you MUST call `channel_disengage` that same turn.',
    '  Posting a `channel_reply` like "ok, I\'ll be quiet" is NOT enough on its',
    '  own: a reply alone re-grants the very stickiness they asked you to drop,',
    '  so without the `channel_disengage` call you stay engaged and keep getting',
    '  pulled back in — exactly what they told you to stop. The acknowledgement',
    '  does not disengage you; the tool call does. If you ack, ack FIRST with',
    '  `channel_reply`, THEN call `channel_disengage`; if you would rather go',
    '  quiet without a word, call `channel_disengage` alone (optionally with',
    '  `skip_response`). Match intent, not exact words: any clear request to',
    '  stop participating counts, whatever the phrasing or language.',
    '',
    '**Every user-facing sentence goes through `channel_reply`.** Narrating in',
    'plain text — "bumping to 16x now", "let me check that" — does NOT reach the',
    'user; it is invisible. If you want the user to see it, it is a',
    '`channel_reply` call, not narration. This includes acks.',
    '',
    '**One substantive reply per inbound.** If the answer needs more than one',
    ...(origin.adapter === 'github'
      ? [
          'tool call, keep working and post the answer with a single final',
          '`channel_reply`. Do not post an "On it" ack comment first — the runtime',
          'already added an :eyes: reaction on engage; use `channel_react` if you',
          'want to acknowledge explicitly. The answer is your reply.',
        ]
      : [
          'tool call, send a one-line ack first via `channel_reply({ text: "On it.",',
          'continue: true })`, keep working, then send the answer with a final',
          '`channel_reply`. The ack is not your reply; the answer is. Once the answer',
          'lands, end your turn. The `continue: true` is not optional on that ack:',
          'without it the turn ends the instant the ack lands and the rest of your',
          'work — the fetch, the subagent, the actual answer — is silently dropped.',
        ]),
    '',
    '**Backgrounded work does not end the obligation.** If you spawn a',
    'subagent with `run_in_background: true` to answer the current inbound,',
    "you have promised a reply you have not delivered yet. Don't skip the",
    'turn — the system will not surface the subagent result on its own.',
    'When the subagent-completion `<system-reminder>` arrives, fetch the',
    'result with `subagent_output` and send it via `channel_reply` in that',
    'turn. `skip_response` (or `NO_REPLY`) is only legal on the post-result',
    'turn if there is genuinely nothing user-facing to share (e.g. the',
    'result is empty or identical to something you already replied with',
    'this conversation) — and in that case, `skip_response({ reason: "..." })`',
    'is preferred so the operator can see why the result was dropped.',
    '',
    'Do not send a second reply just to rephrase, restate, or "confirm in',
    'plain language" something you already said.',
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
    ...renderResearchReportDeliveryGuidance(platformInfo),
    ...renderMentionGuidance(platformInfo, origin.participants ?? [], now, origin.self),
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
  // Exact Discord counts are channel-scoped (filtered by who can VIEW_CHANNEL),
  // so the count is the channel's room, not the guild. The truncated branch is
  // history-derived recent speakers, which is not a channel-membership claim,
  // so the caveat would mislead there.
  const isExact = !membership.truncated && now - membership.fetchedAt < MEMBERSHIP_FRESHNESS_MS
  const caveat =
    isExact && origin.adapter === 'discord-bot' && origin.workspace !== '@dm'
      ? ' (This counts only members who can view this channel, not the whole guild.)'
      : ''
  if (isExact) {
    return `This channel has ${total} members: ${membership.humans} humans, ${membership.bots} bots.${caveat} The 10 most recent speakers are listed below.`
  }
  return `This channel has approximately ${total} members (about ${membership.humans} humans, ${membership.bots} bots — the bot count is approximate, the full member list was not enumerated because it exceeds the 50-member cap). The 10 most recent speakers are listed below.`
}

// The `researcher` subagent always hands back a markdown report file
// (`research-<slug>.md`) and is itself read-only — it cannot produce the PDF.
// Whoever delivers that report to a channel is the one who decides the format,
// and on a channel that accepts file uploads the right default for a multi-page
// research report is a downloadable PDF, not a wall of raw markdown dumped into
// chat. This block makes that the default ONLY where it is actionable: gated on
// `supportsAttachments` so GitHub (whose outbound callback rejects attachments)
// never gets a nudge toward a `channel_send` call that would fail.
function renderResearchReportDeliveryGuidance(platformInfo: PlatformInfo): string[] {
  if (!platformInfo.supportsAttachments) return []
  return [
    `**Ship reports as a PDF by default.** ${platformInfo.displayName} accepts file`,
    'attachments. When the user asks for a report, document, brief, or "the report"',
    '— or a `researcher` subagent hands you a `research-<slug>.md` file path in its',
    '`<report>` block — convert that markdown to a PDF with the `typeclaw-markdown-pdf`',
    'skill and deliver it with `channel_send({ ..., attachments: [{ path, filename }] })`,',
    'with a one- or two-line summary as the message text. A `researcher` `<summary>`',
    'is a teaser, NOT the deliverable: the deliverable is the report file rendered to',
    'PDF. Never build the PDF with an ad-hoc library (jsPDF, pdfkit, a raw-text dump) —',
    'that yields unrendered markdown and mojibake; the skill is the only correct path.',
    "For CJK (Korean/Japanese/Chinese) reports, follow that skill's CJK font gate —",
    'never ship a tofu-rendered PDF; ask before enabling the opt-in `cjkFonts`.',
    'A downloadable file is what a human wants for a multi-page report; do not paste',
    'the full markdown into chat, and do not attach the raw `.md` when asked for a',
    'report or PDF. Send inline plain text only if the caller explicitly asked for it,',
    'or the content is short enough that a file would be overkill.',
    '',
  ]
}

function renderMentionGuidance(
  platformInfo: PlatformInfo,
  participants: readonly ChannelParticipant[],
  now: number,
  self?: ChannelSelfIdentity,
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
        ...renderSelfMention(platformInfo, self),
      ]
    case 'at-username':
      return [
        `To mention someone in your reply, use Telegram syntax \`@username\` in plain text.`,
        `Telegram usernames are a SEPARATE field from \`authorId\`. The \`<@id>\` tokens you see in the participants`,
        'block below are a typeclaw convention for parsing inbound mentions — do not echo them back as outbound mentions.',
        'If you only know an author by their display name and they have no `@username`, address them by display name',
        'and they will see the message via the reply context.',
        ...renderSelfMention(platformInfo, self),
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

// The model knows its NAME from identity files but not its platform user
// id, so a message addressed to its own id reads as "addressed to someone
// else" and it wrongly skips the turn (issue: skipped_by_tool "Message
// addressed to @U…, not to <name>"). This line closes that gap by stating
// the bot's own addressing token explicitly. Empty for the alias platform
// (KakaoTalk has no in-band mention token to recognize) and when identity
// has not resolved yet — both fall through to "omit the line".
function renderSelfMention(platformInfo: PlatformInfo, self: ChannelSelfIdentity | undefined): string[] {
  if (self === undefined) return []
  switch (platformInfo.mentionMode) {
    case 'angle-id': {
      const forms =
        platformInfo.displayName === 'Discord' ? `\`<@${self.id}>\` (also \`<@!${self.id}>\`)` : `\`<@${self.id}>\``
      return [
        '',
        `**You are ${forms} on this ${platformInfo.displayName} workspace.** When a message`,
        `contains your id, it is addressed to YOU — treat it as a mention of yourself, not of`,
        'someone else, and do not skip the turn as "addressed to another user".',
      ]
    }
    case 'at-username': {
      if (self.username === undefined || self.username === '') return []
      return [
        '',
        `**You are \`@${self.username}\` on ${platformInfo.displayName}.** A message mentioning`,
        `\`@${self.username}\` is addressed to YOU — treat it as a mention of yourself, not of`,
        'someone else.',
      ]
    }
    case 'alias':
      return []
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
// Symptom in the wild before PR #183 + this fix: Kiki addressing Momo as
// "Momo님" (plain text) on Discord, which never trips Momo's `isBotMention`
// check, so Momo observes silently and the conversation stalls. The
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
