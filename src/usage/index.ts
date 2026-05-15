import { join } from 'node:path'

import type { Aggregation } from './aggregate'
import { aggregate } from './aggregate'
import { scanAssistantRows } from './scan'

export type { Aggregation, DailyUsage, ModelUsage, SessionUsage, UsageTotals } from './aggregate'
export type { AssistantRow } from './scan'

export type UsageReport = {
  generatedAt: number
  agentDir: string
  range: { since: number | null; until: number | null }
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
    aggregation,
    warnings,
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
