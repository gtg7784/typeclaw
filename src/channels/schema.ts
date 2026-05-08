import { z } from 'zod'

export const ADAPTER_IDS = ['discord-bot', 'slack-bot', 'telegram-bot'] as const

export type AdapterId = (typeof ADAPTER_IDS)[number]

const allowRuleSchema = z.string().min(1).refine(isValidAllowRule, {
  message:
    'allow rule must be one of: *, guild:*, guild:<id>, guild:<id>/<channel>, team:*, team:<id>, team:<id>/<channel>, tg:*, tg:<chat_id>, channel:<id>, dm:*, dm:<id>, im:*, im:<id>',
})

const engagementTriggerSchema = z.enum(['mention', 'reply', 'dm'])

const stickinessSchema = z.union([
  z.literal('off'),
  z.object({
    perReply: z.object({
      window: z
        .number()
        .int()
        .min(1)
        .max(24 * 60 * 60_000),
    }),
  }),
])

export const STICKY_DEFAULT_WINDOW_MS = 5 * 60 * 1000

const engagementSchema = z
  .object({
    trigger: z.array(engagementTriggerSchema).default(['mention', 'reply', 'dm']),
    stickiness: stickinessSchema.default({ perReply: { window: STICKY_DEFAULT_WINDOW_MS } }),
  })
  .default({
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: STICKY_DEFAULT_WINDOW_MS } },
  })

// Cold-start prefetch windows. The router seeds `contextBuffer` once when a
// brand-new channel session is created (no persisted sessionId for the
// (workspace, chat, thread) tuple). Set any field to 0 to disable that side
// of the prefetch. Non-fatal: if the upstream history fetch fails (missing
// scopes, network error, adapter doesn't expose history), the session still
// starts and the agent can call `channel_history` on demand.
//
// Reload semantics: `channels` is `applied` in FIELD_EFFECTS, but prefetch
// only fires at session creation, so changes here only affect the *next*
// cold start; in-flight live sessions are unaffected.
export const PREFETCH_DEFAULTS = {
  thread: { head: 3, tail: 10 },
  channel: { tail: 10 },
} as const

export function defaultHistoryConfig(): {
  prefetch: { thread: { head: number; tail: number }; channel: { tail: number } }
} {
  return {
    prefetch: {
      thread: { head: PREFETCH_DEFAULTS.thread.head, tail: PREFETCH_DEFAULTS.thread.tail },
      channel: { tail: PREFETCH_DEFAULTS.channel.tail },
    },
  }
}

const prefetchWindowSchema = z.number().int().min(0).max(200)

const historySchema = z
  .object({
    prefetch: z
      .object({
        thread: z
          .object({
            head: prefetchWindowSchema.default(PREFETCH_DEFAULTS.thread.head),
            tail: prefetchWindowSchema.default(PREFETCH_DEFAULTS.thread.tail),
          })
          .default({ head: PREFETCH_DEFAULTS.thread.head, tail: PREFETCH_DEFAULTS.thread.tail }),
        channel: z
          .object({
            tail: prefetchWindowSchema.default(PREFETCH_DEFAULTS.channel.tail),
          })
          .default({ tail: PREFETCH_DEFAULTS.channel.tail }),
      })
      .default({
        thread: { head: PREFETCH_DEFAULTS.thread.head, tail: PREFETCH_DEFAULTS.thread.tail },
        channel: { tail: PREFETCH_DEFAULTS.channel.tail },
      }),
  })
  .default({
    prefetch: {
      thread: { head: PREFETCH_DEFAULTS.thread.head, tail: PREFETCH_DEFAULTS.thread.tail },
      channel: { tail: PREFETCH_DEFAULTS.channel.tail },
    },
  })

const adapterSchema = z.object({
  allow: z.array(allowRuleSchema).default([]),
  engagement: engagementSchema,
  history: historySchema,
  enabled: z.boolean().default(true),
})

export const channelsSchema = z
  .object({
    'discord-bot': adapterSchema.optional(),
    'slack-bot': adapterSchema.optional(),
    'telegram-bot': adapterSchema.optional(),
  })
  .default({})

export type AllowRule = string
export type EngagementConfig = z.infer<typeof engagementSchema>
export type ChannelAdapterConfig = z.infer<typeof adapterSchema>
export type ChannelsConfig = z.infer<typeof channelsSchema>

// Discord IDs are numeric snowflakes; Slack IDs start with a single uppercase
// letter (T for teams, C/D/G for channels) followed by alphanumerics; Telegram
// chat IDs are signed integers (negative for groups, `-100…` for supergroups
// and channels). All shapes are accepted on every adapter so the allow list
// stays declarative — the runtime ensures only the right adapter ever sees
// its own IDs.
const RULE_PATTERNS = [
  /^\*$/,
  // Discord
  /^guild:\*$/,
  /^guild:[0-9]+$/,
  /^guild:[0-9]+\/[0-9]+$/,
  /^dm:\*$/,
  /^dm:[0-9]+$/,
  // Slack
  /^team:\*$/,
  /^team:[A-Z0-9]+$/,
  /^team:[A-Z0-9]+\/[A-Z0-9]+$/,
  /^im:\*$/,
  /^im:[A-Z0-9]+$/,
  // Telegram (`tg:*` admits all chats; `tg:<chat_id>` scopes to one chat —
  // numeric, may be negative). There is no team/guild concept; every chat is
  // identified by its absolute id.
  /^tg:\*$/,
  /^tg:-?[0-9]+$/,
  // Shared (channel ids are unique on both platforms)
  /^channel:[A-Z0-9]+$/,
  /^channel:-?[0-9]+$/,
]

function isValidAllowRule(rule: string): boolean {
  return RULE_PATTERNS.some((p) => p.test(rule))
}

export function isAllowed(rules: readonly AllowRule[], workspace: string, chat: string): boolean {
  for (const rule of rules) {
    if (matchRule(rule, workspace, chat)) return true
  }
  return false
}

// `*`              → every workspace channel + every DM (catch-all)
// `guild:*`        → every Discord guild channel (no DMs)
// `guild:G`        → every channel in guild G
// `guild:G/C`      → channel C in guild G only
// `team:*`         → every Slack team channel (no DMs)
// `team:T`         → every channel in team T
// `team:T/C`       → channel C in team T only
// `tg:*`           → every Telegram chat (DMs, groups, supergroups, channels)
// `tg:C`           → Telegram chat C only (signed numeric chat id)
// `channel:C`      → channel C in any workspace (IDs are globally unique on
//                    Discord/Slack and Telegram chat ids are also globally
//                    unique numeric values)
// `dm:*`           → every Discord DM
// `dm:C`           → Discord DM channel C only
// `im:*`           → every Slack DM (im channel)
// `im:D`           → Slack DM channel D only
//
// `guild:`/`dm:`, `team:`/`im:`, and `tg:` identify which adapter the rule
// was written for, but the matcher applies any rule that the
// (workspace, chat) pair satisfies. That keeps the adapter-side coupling at
// the schema/UX layer (Slack users write `team:`, Discord users write
// `guild:`, Telegram users write `tg:`) without bloating the matching logic.
// Telegram has no workspace concept; the adapter pins workspace to
// `'telegram'` so `tg:*` only ever admits Telegram chats.
function matchRule(rule: string, workspace: string, chat: string): boolean {
  if (rule === '*') return true

  if (workspace === '@dm') {
    if (rule === 'dm:*' || rule === 'im:*') return true
    if (rule.startsWith('dm:')) return rule.slice(3) === chat
    if (rule.startsWith('im:')) return rule.slice(3) === chat
    if (rule.startsWith('channel:')) return rule.slice(8) === chat
    return false
  }

  if (workspace === 'telegram') {
    if (rule === 'tg:*') return true
    if (rule.startsWith('tg:')) return rule.slice(3) === chat
    if (rule.startsWith('channel:')) return rule.slice(8) === chat
    return false
  }

  if (rule === 'guild:*' || rule === 'team:*') return true
  if (rule.startsWith('channel:')) return rule.slice(8) === chat
  if (rule.startsWith('guild:')) {
    const body = rule.slice(6)
    const slash = body.indexOf('/')
    if (slash === -1) return body === workspace
    return body.slice(0, slash) === workspace && body.slice(slash + 1) === chat
  }
  if (rule.startsWith('team:')) {
    const body = rule.slice(5)
    const slash = body.indexOf('/')
    if (slash === -1) return body === workspace
    return body.slice(0, slash) === workspace && body.slice(slash + 1) === chat
  }
  return false
}
