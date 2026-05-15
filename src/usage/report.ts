import { styleText } from 'node:util'

import type { ModelUsage, SessionUsage, UsageTotals } from './aggregate'
import { formatCost, formatTokens, isoDay, tokensInOut } from './format'
import type { UsageReport } from './index'

export type FormatOptions = {
  useColor?: boolean
  view?: 'summary' | 'daily' | 'session' | 'models'
  limit?: number
  // Terminal width hint used to size the elastic Item column. Omit to render
  // without truncation (tests, piped output where columns is undefined).
  terminalWidth?: number
}

export function formatReport(report: UsageReport, opts: FormatOptions = {}): string {
  const view = opts.view ?? 'summary'
  const useColor = opts.useColor ?? false
  const ctx: RenderCtx = { useColor, terminalWidth: opts.terminalWidth ?? Number.POSITIVE_INFINITY }
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

type RenderCtx = { useColor: boolean; terminalWidth: number }

function renderSummary(report: UsageReport, ctx: RenderCtx): string {
  const { aggregation } = report
  const sections: string[] = []
  sections.push(header(`USAGE — ${report.agentDir}`, ctx))
  sections.push(dim(`Timezone: ${report.timezone}`, ctx))

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
        aggregation.byModel.map((m) => ({ label: modelLabel(m), modelId: m.model, totals: m })),
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
  const rows = sessions.map((s) => {
    const firstModel = s.models[0]
    const extra = s.models.length > 1 ? `${s.models.length} models` : modelIdFromKey(firstModel)
    return {
      label: `${s.sessionId.slice(0, 12)}  ${dim(isoDay(s.firstAt), ctx)}`,
      totals: s,
      extra,
      extraTruncatable: s.models.length === 1,
    }
  })
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
      models.map((m) => ({ label: modelLabel(m), modelId: m.model, totals: m })),
      ctx,
    ),
  ].join('\n')
}

function modelLabel(m: ModelUsage): string {
  return `${m.provider}/${m.model}`
}

function modelIdFromKey(key: string | undefined): string {
  if (key === undefined) return ''
  const slash = key.indexOf('/')
  return slash === -1 ? key : key.slice(slash + 1)
}

type Row = {
  label: string
  totals: UsageTotals
  extra?: string
  // When truncation kicks in on a model-bearing row, drop the `provider/`
  // prefix from `label` rather than ellipsizing into the prefix. Set by the
  // model and session renderers; date/day rows leave it undefined.
  modelId?: string
  extraTruncatable?: boolean
}

// 2 spaces between columns, matches the existing alignTable join.
const COL_GAP = 2
// Floor below which truncation would erase too much context to be useful.
// "kimi-k2-instr…" at 14 chars still tells you which model family it is.
const MIN_ITEM_WIDTH = 14
const ELLIPSIS = '…'

function renderTotalsTable(rows: Row[], ctx: RenderCtx, opts: { extraHeader?: string } = {}): string {
  const hasExtra = opts.extraHeader !== undefined
  const headers = ['Item', 'Msgs', 'In/Out', 'Cache R/W', 'Cost', ...(hasExtra ? [opts.extraHeader!] : [])]

  const dataCells: string[][] = rows.map((r) => [
    r.label,
    String(r.totals.messageCount),
    tokensInOut(r.totals),
    `${formatTokens(r.totals.cacheRead)} / ${formatTokens(r.totals.cacheWrite)}`,
    formatCost(r.totals.cost),
    ...(hasExtra ? [r.extra ?? ''] : []),
  ])

  const itemColIdx = 0
  const extraColIdx = hasExtra ? headers.length - 1 : -1

  const naturalWidths = computeNaturalWidths([headers, ...dataCells])
  const fixedWidth =
    naturalWidths.reduce((a, b) => a + b, 0) -
    naturalWidths[itemColIdx]! -
    (extraColIdx === -1 ? 0 : naturalWidths[extraColIdx]!) +
    COL_GAP * (naturalWidths.length - 1)
  const elasticBudget = Math.max(0, ctx.terminalWidth - fixedWidth)

  let itemBudget: number
  let extraBudget: number
  if (extraColIdx === -1) {
    itemBudget = Math.max(MIN_ITEM_WIDTH, elasticBudget)
  } else {
    // Split the elastic budget between Item and Extra columns by their natural
    // widths, then clamp each to the MIN_ITEM_WIDTH floor.
    const itemNatural = naturalWidths[itemColIdx]!
    const extraNatural = naturalWidths[extraColIdx]!
    const total = itemNatural + extraNatural
    if (total === 0) {
      itemBudget = MIN_ITEM_WIDTH
      extraBudget = MIN_ITEM_WIDTH
    } else {
      itemBudget = Math.max(MIN_ITEM_WIDTH, Math.floor((elasticBudget * itemNatural) / total))
      extraBudget = Math.max(MIN_ITEM_WIDTH, elasticBudget - itemBudget)
    }
  }

  const truncatedBody = rows.map((r, rowIdx) => {
    const cells = [...dataCells[rowIdx]!]
    cells[itemColIdx] = fitItemCell(cells[itemColIdx]!, r, itemBudget)
    if (extraColIdx !== -1) {
      const allow = r.extraTruncatable !== false
      cells[extraColIdx] = allow ? truncateTail(cells[extraColIdx]!, extraBudget) : cells[extraColIdx]!
    }
    return cells
  })

  return alignTable([headers, ...truncatedBody], ctx)
}

function fitItemCell(label: string, row: Row, budget: number): string {
  const visible = stripAnsi(label).length
  if (visible <= budget) return label
  // Model row: try dropping `provider/` first; if the bare model id still
  // doesn't fit, ellipsize it. Falls through to a plain tail truncation for
  // anything else.
  if (row.modelId !== undefined && row.modelId.length > 0) {
    if (row.modelId.length <= budget) return row.modelId
    return truncateTail(row.modelId, budget)
  }
  return truncateTail(label, budget)
}

function truncateTail(text: string, budget: number): string {
  const visible = stripAnsi(text).length
  if (visible <= budget) return text
  if (budget <= 1) return ELLIPSIS
  // Slice the visible characters of the raw string; ANSI sequences are not
  // present on the labels we truncate (model names, model ids, "N models"),
  // so a substring on the raw value is safe.
  return `${text.slice(0, budget - 1)}${ELLIPSIS}`
}

function computeNaturalWidths(table: string[][]): number[] {
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
  return widths
}

function alignTable(table: string[][], ctx: RenderCtx): string {
  if (table.length === 0) return ''
  const widths = computeNaturalWidths(table)
  const lines: string[] = []
  table.forEach((row, idx) => {
    const cells = row.map((cell, c) => {
      const pad = widths[c]! - stripAnsi(cell).length
      return c === 0 ? cell + ' '.repeat(pad) : ' '.repeat(pad) + cell
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
