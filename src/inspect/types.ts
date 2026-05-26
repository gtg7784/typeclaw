import type { MinimalSessionOrigin } from '@/agent/session-meta'

export const INSPECT_CATEGORIES = [
  'meta',
  'user',
  'assistant',
  'thinking',
  'tool',
  'error',
  'done',
  'broadcast',
  'cron-fire',
  'inbound',
] as const
export type InspectCategory = (typeof INSPECT_CATEGORIES)[number]

export type InboundDecision = 'engage' | 'observe' | 'denied' | 'claim'

export type InspectEvent =
  | { cat: 'meta'; ts: number; origin: MinimalSessionOrigin }
  | { cat: 'user'; ts: number; text: string }
  | { cat: 'assistant'; ts: number; text: string; provider?: string; model?: string }
  // Reasoning trace from the model (Claude extended thinking, OpenAI reasoning
  // summary, Gemini thoughts, etc.). Surfaced for debugging — why the model
  // picked the next tool / wrote the next thing. `redacted` is true when the
  // upstream provider hid the content behind a safety filter and only the
  // opaque continuation payload survives; in that case `text` is empty.
  | { cat: 'thinking'; ts: number; text: string; redacted?: boolean }
  | {
      cat: 'tool'
      ts: number
      phase: 'start' | 'end'
      toolCallId: string
      name: string
      args?: unknown
      result?: unknown
      isError?: boolean
      durationMs?: number
    }
  | { cat: 'error'; ts: number; message: string }
  | {
      cat: 'done'
      ts: number
      stopReason?: string
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      totalTokens: number
      cost: number
    }
  | { cat: 'broadcast'; ts: number; payload: unknown; meta?: Record<string, string> }
  | { cat: 'cron-fire'; ts: number; jobId: string; payload: unknown }
  | {
      cat: 'inbound'
      ts: number
      adapter: string
      workspace: string
      chat: string
      thread: string | null
      authorId: string
      authorName: string
      authorIsBot: boolean
      isDm: boolean
      isBotMention: boolean
      text: string
      externalMessageId: string
      decision: InboundDecision
    }

export type InspectFilter = {
  include?: ReadonlySet<InspectCategory>
  exclude?: ReadonlySet<InspectCategory>
}

export type ParsedFilterResult = { ok: true; filter: InspectFilter } | { ok: false; reason: string }

export function parseFilter(spec: string | undefined): ParsedFilterResult {
  if (spec === undefined || spec.trim() === '') return { ok: true, filter: {} }
  const include = new Set<InspectCategory>()
  const exclude = new Set<InspectCategory>()
  for (const raw of spec.split(',')) {
    const token = raw.trim()
    if (token === '') continue
    const negated = token.startsWith('!')
    const name = (negated ? token.slice(1) : token).toLowerCase()
    if (!isInspectCategory(name)) {
      return { ok: false, reason: `unknown filter category "${name}" (valid: ${INSPECT_CATEGORIES.join(', ')})` }
    }
    if (negated) exclude.add(name)
    else include.add(name)
  }
  const filter: InspectFilter = {}
  if (include.size > 0) filter.include = include
  if (exclude.size > 0) filter.exclude = exclude
  return { ok: true, filter }
}

export function matchesFilter(event: InspectEvent, filter: InspectFilter): boolean {
  if (filter.exclude?.has(event.cat)) return false
  if (filter.include !== undefined && !filter.include.has(event.cat)) return false
  return true
}

function isInspectCategory(value: string): value is InspectCategory {
  return (INSPECT_CATEGORIES as readonly string[]).includes(value)
}

const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/

export type ParsedDurationResult = { ok: true; ms: number } | { ok: false; reason: string }

export function parseDuration(spec: string): ParsedDurationResult {
  const match = DURATION_PATTERN.exec(spec.trim())
  if (!match) return { ok: false, reason: `invalid duration "${spec}" (expected forms: 30s, 5m, 1h, 7d)` }
  const value = Number(match[1])
  const unit = match[2]
  let mult: number
  switch (unit) {
    case 's':
      mult = 1000
      break
    case 'm':
      mult = 60_000
      break
    case 'h':
      mult = 3_600_000
      break
    case 'd':
      mult = 86_400_000
      break
    default:
      return { ok: false, reason: `invalid duration unit "${unit}"` }
  }
  return { ok: true, ms: value * mult }
}
