import { defineCommand } from 'citty'

import { type DreamEntry, renderListRow, runDreams } from '@/dreams'
import { findAgentDir } from '@/init'

import { cancel, errorLine, isCancel } from './ui'

export const dreamsCommand = defineCommand({
  meta: {
    name: 'dreams',
    description: "browse the dreaming subagent's memory-consolidation journal from git history (host stage)",
  },
  args: {
    limit: {
      type: 'string',
      description: 'show at most N most-recent dreams',
    },
    json: {
      type: 'boolean',
      description: 'emit one JSON object per dream (subject-level)',
      default: false,
    },
    details: {
      type: 'boolean',
      description: 'with --json, hydrate each dream with its consolidated fragments/shards/skills',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    const color = useColor()
    const limit = parseLimit(args.limit)

    const result = await runDreams({
      agentDir: cwd,
      json: args.json === true,
      details: args.details === true,
      color,
      ...(limit !== undefined ? { limit } : {}),
      selectDream: (entries) => clackSelect(entries, color),
      stdout: (line) => process.stdout.write(`${line}\n`),
    })

    if (!result.ok) {
      process.stderr.write(`${errorLine(result.reason)}\n`)
      process.exit(result.exitCode)
    }
    process.exit(result.exitCode)
  },
})

function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

async function clackSelect(entries: DreamEntry[], color: boolean): Promise<DreamEntry | null> {
  const { select } = await import('@clack/prompts')
  const picked = await select<string>({
    message: `Pick a dream to open (${entries.length} total)`,
    options: entries.map((entry) => ({
      value: entry.sha,
      label: renderListRow(entry, { color }),
    })),
    initialValue: entries[0]?.sha,
  })
  if (isCancel(picked)) {
    cancel('Cancelled.')
    return null
  }
  return entries.find((entry) => entry.sha === picked) ?? null
}

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}
