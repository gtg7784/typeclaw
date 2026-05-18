import type { AssistantRow, OriginKind } from './scan'
import { ORIGIN_KINDS } from './scan'

export type UsageTotals = {
  messageCount: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

export type DailyUsage = UsageTotals & { date: string; sessionCount: number }
export type ModelUsage = UsageTotals & { provider: string; model: string }
export type SessionUsage = UsageTotals & {
  sessionId: string
  sessionFile: string
  firstAt: number
  lastAt: number
  models: string[]
  originKind: OriginKind
}
export type OriginUsage = UsageTotals & { originKind: OriginKind; sessionCount: number }

export type Aggregation = {
  total: UsageTotals
  byDay: DailyUsage[]
  byModel: ModelUsage[]
  bySession: SessionUsage[]
  byOrigin: OriginUsage[]
}

export async function aggregate(rows: AsyncIterable<AssistantRow>): Promise<Aggregation> {
  const total = emptyTotals()
  const byDay = new Map<string, DailyUsage & { _sessionIds: Set<string> }>()
  const byModel = new Map<string, ModelUsage>()
  const bySession = new Map<string, SessionUsage & { _modelSet: Set<string> }>()
  const byOrigin = new Map<OriginKind, OriginUsage & { _sessionIds: Set<string> }>()

  for await (const row of rows) {
    addInto(total, row)

    const date = isoDate(row.timestamp)
    const sessionKey = sessionIdFromBasename(row.sessionBasename)
    const dayBucket = byDay.get(date) ?? {
      ...emptyTotals(),
      date,
      sessionCount: 0,
      _sessionIds: new Set<string>(),
    }
    addInto(dayBucket, row)
    dayBucket._sessionIds.add(sessionKey)
    dayBucket.sessionCount = dayBucket._sessionIds.size
    byDay.set(date, dayBucket)

    const modelKey = `${row.provider}/${row.model}`
    const modelBucket = byModel.get(modelKey) ?? {
      ...emptyTotals(),
      provider: row.provider,
      model: row.model,
    }
    addInto(modelBucket, row)
    byModel.set(modelKey, modelBucket)

    const sessionBucket = bySession.get(sessionKey) ?? {
      ...emptyTotals(),
      sessionId: sessionKey,
      sessionFile: row.sessionFile,
      firstAt: row.timestamp,
      lastAt: row.timestamp,
      models: [],
      _modelSet: new Set<string>(),
      originKind: row.originKind,
    }
    addInto(sessionBucket, row)
    sessionBucket.firstAt = Math.min(sessionBucket.firstAt, row.timestamp)
    sessionBucket.lastAt = Math.max(sessionBucket.lastAt, row.timestamp)
    sessionBucket._modelSet.add(modelKey)
    sessionBucket.models = [...sessionBucket._modelSet]
    bySession.set(sessionKey, sessionBucket)

    const originBucket = byOrigin.get(row.originKind) ?? {
      ...emptyTotals(),
      originKind: row.originKind,
      sessionCount: 0,
      _sessionIds: new Set<string>(),
    }
    addInto(originBucket, row)
    originBucket._sessionIds.add(sessionKey)
    originBucket.sessionCount = originBucket._sessionIds.size
    byOrigin.set(row.originKind, originBucket)
  }

  return {
    total,
    byDay: [...byDay.values()].map(({ _sessionIds: _, ...rest }) => rest).sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    bySession: [...bySession.values()].map(({ _modelSet: _, ...rest }) => rest).sort((a, b) => b.cost - a.cost),
    byOrigin: [...byOrigin.values()]
      .map(({ _sessionIds: _, ...rest }) => rest)
      .sort((a, b) => originSortIndex(a.originKind) - originSortIndex(b.originKind)),
  }
}

// Stable presentation order for the byOrigin table. Matches ORIGIN_KINDS so
// the renderer doesn't need to know about ordering. 'unknown' is pinned last
// because it represents legacy/malformed data the user probably cares about
// least.
function originSortIndex(kind: OriginKind): number {
  const idx = (ORIGIN_KINDS as readonly OriginKind[]).indexOf(kind)
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
}

function emptyTotals(): UsageTotals {
  return { messageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }
}

function addInto(target: UsageTotals, row: AssistantRow): void {
  target.messageCount += 1
  target.input += row.input
  target.output += row.output
  target.cacheRead += row.cacheRead
  target.cacheWrite += row.cacheWrite
  target.totalTokens += row.totalTokens
  target.cost += row.cost
}

function isoDate(ts: number): string {
  // Local tz so "today" matches the user's wall clock; lexicographic order
  // matches chronological order.
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// File scheme: `${ISO_TIMESTAMP}_${SESSION_UUID}.jsonl` (pi-coding-agent).
// Take the segment after the last underscore so a future suffix-before-ext
// change does not silently regroup messages onto the wrong session.
function sessionIdFromBasename(basename: string): string {
  const stem = basename.endsWith('.jsonl') ? basename.slice(0, -'.jsonl'.length) : basename
  const idx = stem.lastIndexOf('_')
  return idx === -1 ? stem : stem.slice(idx + 1)
}
