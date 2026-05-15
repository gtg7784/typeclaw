import type { UsageTotals } from './aggregate'

export function formatTokens(n: number): string {
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs < 1_000) return String(Math.round(n))
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export function tokensInOut(t: UsageTotals): string {
  return `${formatTokens(t.input)} / ${formatTokens(t.output)}`
}

export function isoDay(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
