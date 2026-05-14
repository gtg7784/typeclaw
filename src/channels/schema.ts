import { z } from 'zod'

export const ADAPTER_IDS = ['discord-bot', 'kakaotalk', 'slack-bot', 'telegram-bot'] as const

export type AdapterId = (typeof ADAPTER_IDS)[number]

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

// Deliberately non-strict: a stale on-disk file may still carry the
// legacy `allow` field (`migrateLegacyConfigShape` lifts it into
// `roles.member.match[]` on load, but a between-reload window can
// briefly contain both). Zod silently drops unknown keys here, which is
// exactly what we want — a hard `.strict()` reject would brick recovery
// for any user mid-migration.
const adapterSchema = z.object({
  engagement: engagementSchema,
  history: historySchema,
  enabled: z.boolean().default(true),
})

// KakaoTalk uses the same shape as every other adapter. There used to be an
// `autoMarkRead` opt-in here; the adapter now fires a LOCO NOTIREAD ack on
// every inbound MSG event unconditionally (see kakaotalk.ts) so the sender's
// unread "1" (노란숫자) clears as soon as the agent observes the message.
// Existing configs with `autoMarkRead: <bool>` continue to parse — Zod's
// default `.object()` strips unknown keys silently — but the field has no
// effect. Risk note: auto-acking every received message is a distinct
// behavioral fingerprint vs a human, so KakaoTalk's abuse detection may
// flag accounts that ack rapidly and unconditionally. Run typeclaw with the
// kakaotalk adapter only on dedicated agent accounts you can afford to lose.
export const channelsSchema = z
  .object({
    'discord-bot': adapterSchema.optional(),
    kakaotalk: adapterSchema.optional(),
    'slack-bot': adapterSchema.optional(),
    'telegram-bot': adapterSchema.optional(),
  })
  .default({})

export type EngagementConfig = z.infer<typeof engagementSchema>
export type ChannelAdapterConfig = z.infer<typeof adapterSchema>
export type ChannelsConfig = z.infer<typeof channelsSchema>
