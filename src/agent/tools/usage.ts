import { Type } from '@mariozechner/pi-ai'
import type { SessionManager } from '@mariozechner/pi-coding-agent'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { AgentSession } from '@/agent'
import { runUsage, startOfDaysAgo, startOfToday, type UsageReport } from '@/usage'
import { formatCost, formatTokens, tokensInOut } from '@/usage/format'

export type CreateUsageToolOptions = {
  agentDir: string
  // Read at execute time so the tool sees the live session this turn was
  // dispatched into (channel sessions reuse the same AgentSession across
  // turns, but the SessionManager identity stays stable inside a turn).
  getSession?: () => Pick<AgentSession, 'sessionManager' | 'getSessionStats'> | undefined
}

const SCOPES = ['current', 'today', 'last_7d', 'last_30d', 'all_time', 'default'] as const
type Scope = (typeof SCOPES)[number]

export function createUsageTool({ agentDir, getSession }: CreateUsageToolOptions) {
  return defineTool({
    name: 'usage',
    label: 'Token Usage',
    description:
      'Report token usage and dollar cost for this agent. Read-only; aggregates the persisted ' +
      '`sessions/*.jsonl` files written by every assistant turn (cost is already computed per turn ' +
      'by the LLM client). ' +
      'Scopes: `current` (this chat only, in-memory from the live AgentSession — instant), ' +
      "`today` / `last_7d` / `last_30d` (calendar windows in the user's local timezone, scans on-disk JSONL), " +
      '`all_time` (every persisted assistant message ever), ' +
      '`default` (compact summary: current + today + last_7d). ' +
      'Use when the user asks "how much have I used / spent", "what did this conversation cost", ' +
      '"token usage this week", or similar billing-style questions. The summary in the text field is ' +
      'safe to quote verbatim; `details` carries the full numeric breakdown if you need to compare or compute.',
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union(
          SCOPES.map((s) => Type.Literal(s)),
          {
            description: "Aggregation window. Omit for the default 'current + today + last_7d' summary.",
          },
        ),
      ),
    }),

    async execute(_toolCallId, params) {
      const scope: Scope = params.scope ?? 'default'
      const liveSession = getSession?.()
      const sessionStats = liveSession !== undefined ? safeGetStats(liveSession) : undefined

      if (scope === 'current') {
        return renderCurrent(sessionStats)
      }

      if (scope === 'default') {
        const today = await runUsage({ agentDir, since: startOfToday() })
        const last7 = await runUsage({ agentDir, since: startOfDaysAgo(7) })
        return renderDefault(sessionStats, today, last7, agentDir)
      }

      const since = scope === 'all_time' ? undefined : sinceForScope(scope)
      const report = await runUsage({ agentDir, ...(since !== undefined ? { since } : {}) })
      return renderScopedReport(scope, report)
    },
  })
}

function sinceForScope(scope: Exclude<Scope, 'current' | 'default' | 'all_time'>): number {
  switch (scope) {
    case 'today':
      return startOfToday()
    case 'last_7d':
      return startOfDaysAgo(7)
    case 'last_30d':
      return startOfDaysAgo(30)
  }
}

type SessionStatsLike = {
  sessionId: string
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
}

function safeGetStats(session: Pick<AgentSession, 'sessionManager' | 'getSessionStats'>): SessionStatsLike | undefined {
  try {
    return session.getSessionStats() as SessionStatsLike
  } catch {
    return undefined
  }
}

function renderCurrent(stats: SessionStatsLike | undefined) {
  if (stats === undefined) {
    return errorResult('No live session available; try `scope: "today"` or `"all_time"` instead.')
  }
  const text =
    `This conversation so far: ${formatTokens(stats.tokens.input)} in / ${formatTokens(stats.tokens.output)} out` +
    ` (${formatTokens(stats.tokens.total)} total), cost ${formatCost(stats.cost)}` +
    ` across ${stats.totalMessages} message(s).`
  return result(text, {
    scope: 'current',
    sessionId: stats.sessionId,
    messages: stats.totalMessages,
    tokens: stats.tokens,
    cost: stats.cost,
  })
}

function renderDefault(stats: SessionStatsLike | undefined, today: UsageReport, last7: UsageReport, agentDir: string) {
  const lines: string[] = []
  if (stats !== undefined) {
    lines.push(
      `This chat: ${tokensInOutFromStats(stats)} (${formatTokens(stats.tokens.total)} total), ${formatCost(stats.cost)} across ${stats.totalMessages} msg.`,
    )
  }
  const t = today.aggregation.total
  const w = last7.aggregation.total
  lines.push(
    `Today: ${tokensInOut(t)} (${formatTokens(t.totalTokens)} total), ${formatCost(t.cost)} across ${t.messageCount} assistant msg in ${today.aggregation.bySession.length} session(s).`,
  )
  lines.push(
    `Last 7 days: ${tokensInOut(w)} (${formatTokens(w.totalTokens)} total), ${formatCost(w.cost)} across ${w.messageCount} assistant msg in ${last7.aggregation.bySession.length} session(s).`,
  )
  if (last7.aggregation.byModel.length > 0) {
    const topModel = last7.aggregation.byModel[0]!
    lines.push(`Top model (7d): ${topModel.provider}/${topModel.model} — ${formatCost(topModel.cost)}.`)
  }
  return result(lines.join('\n'), {
    scope: 'default',
    agentDir,
    current:
      stats !== undefined
        ? { sessionId: stats.sessionId, messages: stats.totalMessages, tokens: stats.tokens, cost: stats.cost }
        : null,
    today: snapshot(today),
    last_7d: snapshot(last7),
  })
}

function renderScopedReport(scope: Exclude<Scope, 'current' | 'default'>, report: UsageReport) {
  const t = report.aggregation.total
  if (t.messageCount === 0) {
    return result(`No assistant turns recorded for scope=${scope}.`, {
      scope,
      ...snapshot(report),
    })
  }
  const lines: string[] = [
    `${humanScope(scope)}: ${tokensInOut(t)} (${formatTokens(t.totalTokens)} total), ${formatCost(t.cost)} across ${t.messageCount} assistant msg in ${report.aggregation.bySession.length} session(s).`,
  ]
  if (report.aggregation.byModel.length > 0) {
    const topModels = report.aggregation.byModel.slice(0, 3)
    const breakdown = topModels.map((m) => `${m.provider}/${m.model} ${formatCost(m.cost)}`).join(', ')
    lines.push(`Top model${topModels.length > 1 ? 's' : ''}: ${breakdown}.`)
  }
  return result(lines.join('\n'), { scope, ...snapshot(report) })
}

function snapshot(report: UsageReport) {
  return {
    range: report.range,
    total: report.aggregation.total,
    sessionCount: report.aggregation.bySession.length,
    byModel: report.aggregation.byModel.map((m) => ({
      provider: m.provider,
      model: m.model,
      messageCount: m.messageCount,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      totalTokens: m.totalTokens,
      cost: m.cost,
    })),
    warnings: report.warnings,
  }
}

function humanScope(scope: Exclude<Scope, 'current' | 'default'>): string {
  switch (scope) {
    case 'today':
      return 'Today'
    case 'last_7d':
      return 'Last 7 days'
    case 'last_30d':
      return 'Last 30 days'
    case 'all_time':
      return 'All time'
  }
}

function tokensInOutFromStats(stats: SessionStatsLike): string {
  return `${formatTokens(stats.tokens.input)} in / ${formatTokens(stats.tokens.output)} out`
}

function result(text: string, details: object) {
  return { content: [{ type: 'text' as const, text }], details }
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: { ok: false } }
}
