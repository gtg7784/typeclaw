import { z } from 'zod'

export const ADAPTER_IDS = ['discord-bot'] as const

export type AdapterId = (typeof ADAPTER_IDS)[number]

const allowRuleSchema = z.string().min(1).refine(isValidAllowRule, {
  message: 'allow rule must be one of: *, guild:*, guild:<id>, guild:<id>/<channel>, channel:<id>, dm:*, dm:<id>',
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
  })
  .default({})

export type AllowRule = string
export type EngagementConfig = z.infer<typeof engagementSchema>
export type ChannelAdapterConfig = z.infer<typeof adapterSchema>
export type ChannelsConfig = z.infer<typeof channelsSchema>

const RULE_PATTERNS = [
  /^\*$/,
  /^guild:\*$/,
  /^guild:[0-9]+$/,
  /^guild:[0-9]+\/[0-9]+$/,
  /^channel:[0-9]+$/,
  /^dm:\*$/,
  /^dm:[0-9]+$/,
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

// `*`     → every guild channel + every DM (also accepted as deliberate shorthand)
// `guild:*`         → every guild channel (no DMs)
// `guild:G`         → every channel in guild G
// `guild:G/C`       → channel C in guild G only
// `channel:C`       → channel C in any guild (Discord IDs are globally unique)
// `dm:*`            → every DM
// `dm:C`            → DM channel C only
function matchRule(rule: string, workspace: string, chat: string): boolean {
  if (rule === '*') return true

  if (workspace === '@dm') {
    if (rule === 'dm:*') return true
    if (rule.startsWith('dm:')) return rule.slice(3) === chat
    if (rule.startsWith('channel:')) return rule.slice(8) === chat
    return false
  }

  if (rule === 'guild:*') return true
  if (rule.startsWith('channel:')) return rule.slice(8) === chat
  if (rule.startsWith('guild:')) {
    const body = rule.slice(6)
    const slash = body.indexOf('/')
    if (slash === -1) return body === workspace
    return body.slice(0, slash) === workspace && body.slice(slash + 1) === chat
  }
  return false
}

export function isEngagementOff(engagement: EngagementConfig): boolean {
  return engagement.trigger.length === 0 && engagement.stickiness === 'off'
}
