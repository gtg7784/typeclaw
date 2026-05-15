import { styleText } from 'node:util'

import type { ModelUsage, SessionUsage, UsageTotals } from './aggregate'
import { formatCost, formatTokens, isoDay, tokensInOut } from './format'
import type { UsageReport } from './index'

export type FormatOptions = {
  useColor?: boolean
  compact?: boolean
  view?: 'summary' | 'daily' | 'session' | 'models'
  limit?: number
}

export function formatReport(report: UsageReport, opts: FormatOptions = {}): string {
  const view = opts.view ?? 'summary'
  const useColor = opts.useColor ?? false
  const compact = opts.compact ?? false
  const ctx = { useColor, compact }
  switch (view) {
    case 'summary':
      return renderSummary(report, ctx)
    case 'daily':
      return renderDaily(report, ctx, opts.limit)
    case 'session':
      return renderSessions(report, ctx, opts.limit ?? 20)
    case 'models':
      return renderModels(report, ctx, opts.limit)
  }
}

export function formatJson(report: UsageReport): string {
  return JSON.stringify(report, null, 2)
}

type RenderCtx = { useColor: boolean; compact: boolean }

function renderSummary(report: UsageReport, ctx: RenderCtx): string {
  const { aggregation } = report
  const sections: string[] = []
  sections.push(header(`USAGE — ${report.agentDir}`, ctx))

  if (aggregation.bySession.length === 0) {
    sections.push(dim('No assistant turns recorded yet.', ctx))
    return sections.join('\n')
  }

  const total = aggregation.total
  sections.push(
    `${dim('Sessions:', ctx)} ${aggregation.bySession.length}` +
      `  ${dim('Messages:', ctx)} ${total.messageCount}` +
      `  ${dim('Tokens:', ctx)} ${tokensInOut(total)}` +
      `  ${dim('Cost:', ctx)} ${formatCost(total.cost)}`,
  )

  if (aggregation.byDay.length > 0) {
    sections.push('')
    sections.push(header('By day (most recent first)', ctx))
    const recent = aggregation.byDay.slice(-7).reverse()
    sections.push(
      renderTotalsTable(
        recent.map((d) => ({ label: d.date, totals: d })),
        ctx,
      ),
    )
  }

  if (aggregation.byModel.length > 0) {
    sections.push('')
    sections.push(header('By model', ctx))
    sections.push(
      renderTotalsTable(
        aggregation.byModel.map((m) => ({ label: `${m.provider}/${m.model}`, totals: m })),
        ctx,
      ),
    )
  }

  if (report.warnings.length > 0) {
    sections.push('')
    sections.push(color('yellow', `${report.warnings.length} warning(s):`, ctx))
    for (const w of report.warnings) sections.push(`  - ${w}`)
  }

  return sections.join('\n')
}

function renderDaily(report: UsageReport, ctx: RenderCtx, limit: number | undefined): string {
  const days = limit !== undefined ? report.aggregation.byDay.slice(-limit) : report.aggregation.byDay
  if (days.length === 0) return dim('No usage in range.', ctx)
  const lines = [
    header(`USAGE BY DAY — ${report.agentDir}`, ctx),
    renderTotalsTable(
      days.map((d) => ({ label: d.date, totals: d })),
      ctx,
    ),
  ]
  return lines.join('\n')
}

function renderSessions(report: UsageReport, ctx: RenderCtx, limit: number): string {
  const sessions = report.aggregation.bySession.slice(0, limit)
  if (sessions.length === 0) return dim('No sessions in range.', ctx)
  const rows = sessions.map((s) => ({
    label: `${s.sessionId.slice(0, 12)}  ${dim(isoDay(s.firstAt), ctx)}`,
    totals: s,
    extra: s.models.length > 1 ? `${s.models.length} models` : (s.models[0] ?? ''),
  }))
  return [
    header(`USAGE BY SESSION (top ${limit} by cost) — ${report.agentDir}`, ctx),
    renderTotalsTable(rows, ctx, { extraHeader: 'Model' }),
  ].join('\n')
}

function renderModels(report: UsageReport, ctx: RenderCtx, limit: number | undefined): string {
  const models = limit !== undefined ? report.aggregation.byModel.slice(0, limit) : report.aggregation.byModel
  if (models.length === 0) return dim('No models in range.', ctx)
  return [
    header(`USAGE BY MODEL — ${report.agentDir}`, ctx),
    renderTotalsTable(
      models.map((m) => ({ label: `${m.provider}/${m.model}`, totals: m })),
      ctx,
    ),
  ].join('\n')
}

type Row = { label: string; totals: UsageTotals; extra?: string }

function renderTotalsTable(rows: Row[], ctx: RenderCtx, opts: { extraHeader?: string } = {}): string {
  const showCache = !ctx.compact
  const headers = [
    'Item',
    'Msgs',
    'In/Out',
    ...(showCache ? ['Cache R/W'] : []),
    'Cost',
    ...(opts.extraHeader !== undefined ? [opts.extraHeader] : []),
  ]
  const body = rows.map((r) => [
    r.label,
    String(r.totals.messageCount),
    tokensInOut(r.totals),
    ...(showCache ? [`${formatTokens(r.totals.cacheRead)} / ${formatTokens(r.totals.cacheWrite)}`] : []),
    formatCost(r.totals.cost),
    ...(opts.extraHeader !== undefined ? [r.extra ?? ''] : []),
  ])
  return alignTable([headers, ...body], ctx)
}

function alignTable(table: string[][], ctx: RenderCtx): string {
  if (table.length === 0) return ''
  const cols = table[0]?.length ?? 0
  const widths: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = 0
    for (const row of table) {
      const cell = row[c] ?? ''
      const visible = stripAnsi(cell).length
      if (visible > w) w = visible
    }
    widths.push(w)
  }
  const lines: string[] = []
  table.forEach((row, idx) => {
    const cells = row.map((cell, c) => {
      const pad = widths[c]! - stripAnsi(cell).length
      const aligned = c === 0 ? cell + ' '.repeat(pad) : ' '.repeat(pad) + cell
      return aligned
    })
    const line = cells.join('  ')
    lines.push(idx === 0 ? bold(line, ctx) : line)
  })
  return lines.join('\n')
}

function header(text: string, ctx: RenderCtx): string {
  return bold(text, ctx)
}

function bold(text: string, ctx: RenderCtx): string {
  return color('bold', text, ctx)
}

function dim(text: string, ctx: RenderCtx): string {
  return color('dim', text, ctx)
}

function color(modifier: Parameters<typeof styleText>[0], text: string, ctx: RenderCtx): string {
  if (!ctx.useColor) return text
  return styleText(modifier, text)
}

// ANSI escape sequences would inflate column widths and break alignment under
// --no-color piping; strip before measuring.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '')
}
