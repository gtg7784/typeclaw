import { z } from 'zod'

export const ADAPTER_IDS = ['discord-bot', 'slack-bot'] as const

export type AdapterId = (typeof ADAPTER_IDS)[number]

const allowRuleSchema = z.string().min(1).refine(isValidAllowRule, {
  message:
    'allow rule must be one of: *, guild:*, guild:<id>, guild:<id>/<channel>, team:*, team:<id>, team:<id>/<channel>, channel:<id>, dm:*, dm:<id>, im:*, im:<id>',
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

const adapterSchema = z.object({
  allow: z.array(allowRuleSchema).default([]),
  engagement: engagementSchema,
  enabled: z.boolean().default(true),
})

export const channelsSchema = z
  .object({
    'discord-bot': adapterSchema.optional(),
    'slack-bot': adapterSchema.optional(),
  })
  .default({})

export type AllowRule = string
export type EngagementConfig = z.infer<typeof engagementSchema>
export type ChannelAdapterConfig = z.infer<typeof adapterSchema>
export type ChannelsConfig = z.infer<typeof channelsSchema>

// Discord IDs are numeric snowflakes; Slack IDs start with a single uppercase
// letter (T for teams, C/D/G for channels) followed by alphanumerics. Both
// shapes are accepted on every adapter so the allow list stays declarative —
// the runtime ensures only the right adapter ever sees its own IDs.
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
  // Shared (channel ids are unique on both platforms)
  /^channel:[A-Z0-9]+$/,
  /^channel:[0-9]+$/,
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
// `channel:C`      → channel C in any workspace (IDs are globally unique on
//                    both Discord and Slack)
// `dm:*`           → every Discord DM
// `dm:C`           → Discord DM channel C only
// `im:*`           → every Slack DM (im channel)
// `im:D`           → Slack DM channel D only
//
// `guild:`/`dm:` and `team:`/`im:` are siblings: they identify which adapter
// the rule was written for, but the matcher applies any rule that the
// (workspace, chat) pair satisfies. That keeps the adapter-side coupling at
// the schema/UX layer (Slack users write `team:`, Discord users write
// `guild:`) without bloating the matching logic.
function matchRule(rule: string, workspace: string, chat: string): boolean {
  if (rule === '*') return true

  if (workspace === '@dm') {
    if (rule === 'dm:*' || rule === 'im:*') return true
    if (rule.startsWith('dm:')) return rule.slice(3) === chat
    if (rule.startsWith('im:')) return rule.slice(3) === chat
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

export function isEngagementOff(engagement: EngagementConfig): boolean {
  return engagement.trigger.length === 0 && engagement.stickiness === 'off'
}
