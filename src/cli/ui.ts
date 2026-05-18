import { styleText } from 'node:util'

import { cancel, intro, isCancel, log, note, outro, spinner as clackSpinner } from '@clack/prompts'

import { type AutoUpgradeOutcome, describeAutoUpgrade } from '@/init/auto-upgrade'

export { cancel, intro, isCancel, log, note, outro }

function colorize(modifier: Parameters<typeof styleText>[0], s: string): string {
  if (!colorsEnabled()) return s
  return styleText(modifier, s)
}

// Re-evaluated per call so tests can mutate NO_COLOR / FORCE_COLOR between
// cases without stale module-load caching.
function colorsEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}

export const c = {
  cyan: (s: string) => colorize('cyan', s),
  green: (s: string) => colorize('green', s),
  red: (s: string) => colorize('red', s),
  yellow: (s: string) => colorize('yellow', s),
  dim: (s: string) => colorize('dim', s),
  gray: (s: string) => colorize('gray', s),
  magenta: (s: string) => colorize('magenta', s),
  bold: (s: string) => colorize('bold', s),
}

// OSC 8 hyperlink with plain fallback when colors are off so piped output
// and non-OSC-8 terminals stay readable.
export function link(text: string, url: string): string {
  if (!colorsEnabled()) return `${text} (${url})`
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`
}

export type Spinner = {
  start: (msg?: string) => void
  stop: (msg?: string) => void
  error: (msg?: string) => void
  cancel: (msg?: string) => void
  message: (msg?: string) => void
}

export function spinner(): Spinner {
  const s = clackSpinner()
  return {
    start: (msg) => s.start(msg),
    stop: (msg) => s.stop(msg),
    error: (msg) => s.error(msg),
    cancel: (msg) => s.cancel(msg),
    message: (msg) => s.message(msg),
  }
}

export type StartLikeResult = {
  alreadyRunning?: boolean
  built: boolean
  plan: { containerName: string; imageTag: string }
  hostPort: number
  containerId: string
  hostd: { state: 'registered' } | { state: 'unavailable'; reason: string } | { state: 'disabled' }
  autoUpgrade?: AutoUpgradeOutcome
}

export function renderStartSuccess(result: StartLikeResult): string {
  const lines: string[] = []
  const name = c.cyan(result.plan.containerName)
  const port = c.green(String(result.hostPort))

  if (result.autoUpgrade) {
    const message = describeAutoUpgrade(result.autoUpgrade)
    if (message.length > 0) {
      const tint = result.autoUpgrade.kind === 'exact-pin-respected' ? c.yellow : c.cyan
      lines.push(tint(message))
    }
  }

  if (result.alreadyRunning) {
    lines.push(`${c.green('●')} ${name} is already running on host port ${port}.`)
  } else {
    if (result.built) {
      lines.push(`Built image ${c.cyan(result.plan.imageTag)}.`)
    }
    const shortId = result.containerId.slice(0, 12)
    lines.push(`${c.green('●')} ${name} started on host port ${port} ${c.dim(`(${shortId})`)}.`)
  }

  if (result.hostd.state === 'registered') {
    lines.push(c.dim('Host daemon active.'))
  } else if (result.hostd.state === 'unavailable') {
    lines.push(`${c.yellow('Host daemon unavailable:')} ${result.hostd.reason}`)
  }

  lines.push('')
  lines.push(`${c.dim('Follow logs:')}  ${c.cyan('typeclaw logs -f')}`)
  lines.push(`${c.dim('Attach TUI:')}   ${c.cyan('typeclaw tui')}`)
  lines.push(`${c.dim('Stop:')}         ${c.cyan('typeclaw stop')}`)

  return lines.join('\n')
}

export type NextStepHint = { label: string; command: string }

// `details` goes into the body, not the title: clack's `note()` sizes the
// box to the title's visual width and never wraps titles, so a long title
// breaks the layout on narrow terminals. Body content is wrapped to fit.
export function done(opts: { title: string; details?: string; hints: NextStepHint[] }): void {
  const lines: string[] = []
  if (opts.details !== undefined && opts.details !== '') lines.push(opts.details)
  for (const h of opts.hints) lines.push(`${c.dim(h.label)}  ${c.cyan(h.command)}`)
  note(lines.join('\n'), opts.title)
  outro(c.green('Done.'))
}

export function errorLine(reason: string): string {
  return `${c.red('✖')} ${reason}`
}

export function successLine(message: string): string {
  return `${c.green('●')} ${message}`
}
