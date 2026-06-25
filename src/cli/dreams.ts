import { defineCommand } from 'citty'

import { type DreamEntry, renderListRow, runDreams, type ViewAction } from '@/dreams'

import { createEscController } from './inspect-controller'
import { requireAgentDir } from './require-agent-dir'
import { c, cancel, errorLine, isCancel, prepareStdinForClack } from './ui'

const ESC_DEBOUNCE_MS = 50
const QUIT_KEY = 0x71

export const dreamsCommand = defineCommand({
  meta: {
    name: 'dreams',
    description: "browse the dreaming subagent's memory-consolidation journal",
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
    const cwd = requireAgentDir()
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

type RawInput = Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'>

// Esc routes through createEscController so a standalone Esc returns 'back'
// while a multi-byte CSI sequence (↑/↓ arrows) does not. Teardown restores
// raw mode but deliberately does NOT pause stdin: clack cannot re-flow a
// paused process.stdin under Bun, so the next picker would freeze — the same
// reason cli/inspect.ts leaves the stream flowing on its return path.
export async function waitForViewerKey(color: boolean, input: RawInput = process.stdin): Promise<ViewAction> {
  const stdin = input
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return 'exit'

  process.stdout.write(`${viewerHintLine(color)}\n`)

  const ctrl = createEscController({ debounceMs: ESC_DEBOUNCE_MS })
  const escSignal = ctrl.armForStream()

  return new Promise<ViewAction>((resolve) => {
    let settled = false
    const finish = (action: ViewAction): void => {
      if (settled) return
      settled = true
      escSignal.removeEventListener('abort', onEscAbort)
      stdin.off('data', onData)
      ctrl.dispose()
      try {
        stdin.setRawMode(false)
      } catch {
        /* terminal already torn down */
      }
      resolve(action)
    }
    const onEscAbort = (): void => finish('back')
    const onData = (chunk: Buffer): void => {
      if (chunk[0] === QUIT_KEY) {
        finish('exit')
        return
      }
      const { sigint } = ctrl.onChunk(chunk)
      if (sigint) finish('exit')
    }
    escSignal.addEventListener('abort', onEscAbort, { once: true })
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
  prepareStdinForClack()
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
