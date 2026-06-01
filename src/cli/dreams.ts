import { defineCommand } from 'citty'

import { type DreamEntry, renderListRow, runDreams, type ViewAction } from '@/dreams'
import { findAgentDir } from '@/init'

import { c, cancel, errorLine, isCancel } from './ui'

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
    const interactive = isInteractive() && args.json !== true

    const result = await runDreams({
      agentDir: cwd,
      json: args.json === true,
      details: args.details === true,
      color,
      ...(limit !== undefined ? { limit } : {}),
      selectDream: (entries, selectOpts) => clackSelect(entries, color, selectOpts?.initialSha),
      ...(interactive ? { viewDream: () => waitForViewerKey(color) } : {}),
      stdout: (line) => process.stdout.write(`${line}\n`),
    })

    if (!result.ok) {
      process.stderr.write(`${errorLine(result.reason)}\n`)
      process.exit(result.exitCode)
    }
    process.exit(result.exitCode)
  },
})

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY)
}

// Raw mode is entered only for this wait and always restored, so a thrown
// error never leaves the terminal stuck (same contract as cli/inspect.ts).
async function waitForViewerKey(color: boolean): Promise<ViewAction> {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return 'exit'

  process.stdout.write(`${viewerHintLine(color)}\n`)

  return new Promise<ViewAction>((resolve) => {
    let settled = false
    const finish = (action: ViewAction): void => {
      if (settled) return
      settled = true
      stdin.off('data', onData)
      try {
        stdin.setRawMode(false)
      } catch {
        /* terminal already torn down */
      }
      stdin.pause()
      resolve(action)
    }
    const onData = (chunk: Buffer): void => {
      const byte = chunk[0]
      if (byte === undefined) return
      if (byte === 0x1b) finish('back')
      else if (byte === 0x03 || byte === 0x71) finish('exit')
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

function viewerHintLine(color: boolean): string {
  const text = '(esc to go back to the list · q to quit)'
  return color ? c.dim(text) : text
}

function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

async function clackSelect(
  entries: DreamEntry[],
  color: boolean,
  initialSha: string | undefined,
): Promise<DreamEntry | null> {
  const { select } = await import('@clack/prompts')
  const preferred = initialSha !== undefined && entries.some((e) => e.sha === initialSha) ? initialSha : entries[0]?.sha
  const picked = await select<string>({
    message: `Pick a dream to open (${entries.length} total)`,
    options: entries.map((entry) => ({
      value: entry.sha,
      label: renderListRow(entry, { color }),
    })),
    initialValue: preferred,
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
