import { defineCommand } from 'citty'

import { findAgentDir } from '@/init'
import { runUsage, startOfDaysAgo, startOfToday } from '@/usage'
import { formatJson, formatReport } from '@/usage/report'

type View = 'summary' | 'daily' | 'session' | 'models'

const COMMON_ARGS = {
  json: {
    type: 'boolean' as const,
    description: 'emit the usage report as JSON',
    default: false,
  },
  since: {
    type: 'string' as const,
    description: "ISO date or relative duration ('today', '7d', '30d')",
  },
  until: {
    type: 'string' as const,
    description: 'ISO date upper bound (exclusive)',
  },
  compact: {
    type: 'boolean' as const,
    description: 'force compact mode (drops cache columns)',
    default: false,
  },
  cwd: {
    type: 'string' as const,
    description: 'override the agent folder',
  },
}

const subcommand = (view: View, description: string) =>
  defineCommand({
    meta: { name: view, description },
    args: {
      ...COMMON_ARGS,
      ...(view === 'session' ? { limit: { type: 'string' as const, description: 'max sessions (default 20)' } } : {}),
    },
    async run({ args }) {
      await emit(view, args)
    },
  })

export const usageCommand = defineCommand({
  meta: {
    name: 'usage',
    description: 'report LLM token usage and cost for this agent folder',
  },
  args: COMMON_ARGS,
  subCommands: {
    daily: subcommand('daily', 'one row per calendar day'),
    session: subcommand('session', 'top sessions by cost'),
    models: subcommand('models', 'one row per provider/model'),
  },
  async run({ args }) {
    // citty invokes both the matched subcommand's `run` and the parent's
    // `run`. Suppress the summary when a subcommand was dispatched so the
    // user does not see the subcommand output followed by an unrelated
    // summary block.
    const first = args._?.[0]
    if (first === 'daily' || first === 'session' || first === 'models') return
    await emit('summary', args)
  },
})

async function emit(view: View, args: Record<string, unknown>): Promise<void> {
  const cwdArg = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : process.cwd()
  const agentDir = findAgentDir(cwdArg) ?? cwdArg
  const since = parseSince(args.since)
  const until = parseUntil(args.until)
  const limit = parseLimit(args.limit)

  const report = await runUsage({
    agentDir,
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  })

  if (args.json === true) {
    process.stdout.write(`${formatJson(report)}\n`)
    return
  }

  const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
  const compact = args.compact === true || (process.stdout.columns ?? 120) < 100
  const text = formatReport(report, {
    useColor,
    compact,
    view,
    ...(limit !== undefined ? { limit } : {}),
  })
  process.stdout.write(`${text}\n`)
}

function parseSince(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value === 'today') return startOfToday()
  const days = /^(\d+)d$/.exec(value)
  if (days) return startOfDaysAgo(Number(days[1]))
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function parseUntil(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function parseLimit(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}
