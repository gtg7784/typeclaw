import { join } from 'node:path'

import type { Aggregation } from './aggregate'
import { aggregate } from './aggregate'
import { scanAssistantRows } from './scan'

export type { Aggregation, DailyUsage, ModelUsage, OriginUsage, SessionUsage, UsageTotals } from './aggregate'
export type { AssistantRow, OriginKind } from './scan'
export { ORIGIN_KINDS } from './scan'

export type UsageReport = {
  generatedAt: number
  agentDir: string
  range: { since: number | null; until: number | null }
  // The process timezone used by the date helpers (startOfToday,
  // startOfDaysAgo) and by per-day grouping. Container processes default to
  // UTC; host CLI uses the user's local TZ. Surfaced explicitly so consumers
  // (humans, --json, downstream tooling) can interpret "today" unambiguously.
  timezone: string
  aggregation: Aggregation
  warnings: string[]
}

export type RunUsageOptions = {
  agentDir: string
  since?: number
  until?: number
}

export async function runUsage(opts: RunUsageOptions): Promise<UsageReport> {
  const warnings: string[] = []
  const sessionsDir = join(opts.agentDir, 'sessions')
  const rows = scanAssistantRows({
    sessionsDir,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
    onWarn: (m) => warnings.push(m),
  })
  const aggregation = await aggregate(rows)
  return {
    generatedAt: Date.now(),
    agentDir: opts.agentDir,
    range: { since: opts.since ?? null, until: opts.until ?? null },
    timezone: processTimezone(),
    aggregation,
    warnings,
  }
}

function processTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return process.env.TZ ?? 'UTC'
  }
}

export function startOfToday(now: Date = new Date()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function startOfDaysAgo(days: number, now: Date = new Date()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return d.getTime()
}
