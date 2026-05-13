// Per-source line tinting for `typeclaw logs` and `typeclaw compose logs`.
// PR #146's wall-clock timestamp prefix made every line start identically,
// dropping readability when many sources interleave. We restore visual
// grouping by tinting each line based on its first `[tag]` (`[plugin:memory]`,
// `[memory-logger]`, etc.). Same trick `compose/logs.ts#colorFor` uses for
// agent names — stable hash → palette index → ANSI escape that wraps the
// whole line body.
//
// Lines without a `[tag]` get no tint (only the leading timestamp is dimmed),
// so untagged docker output, raw stack traces, and channel adapter logs
// stay readable without inheriting a misleading color.

import type { WritableStream as NodeWritable } from 'node:stream/web'

const ANSI_RESET = '\x1b[0m'
const ANSI_DIM = '\x1b[2m'
const ANSI_CYAN = '\x1b[36m'
const ANSI_YELLOW = '\x1b[33m'
const ANSI_GREEN = '\x1b[32m'
const ANSI_MAGENTA = '\x1b[35m'
const ANSI_BLUE = '\x1b[34m'
const ANSI_BRIGHT_CYAN = '\x1b[96m'
const ANSI_BRIGHT_YELLOW = '\x1b[93m'
const ANSI_BRIGHT_GREEN = '\x1b[92m'
const ANSI_BRIGHT_MAGENTA = '\x1b[95m'
const ANSI_BRIGHT_BLUE = '\x1b[94m'

const TAG_PALETTE = [
  ANSI_CYAN,
  ANSI_YELLOW,
  ANSI_GREEN,
  ANSI_MAGENTA,
  ANSI_BLUE,
  ANSI_BRIGHT_CYAN,
  ANSI_BRIGHT_YELLOW,
  ANSI_BRIGHT_GREEN,
  ANSI_BRIGHT_MAGENTA,
  ANSI_BRIGHT_BLUE,
] as const

// Anchored to line start with a trailing space so a date that happens to
// appear mid-line doesn't get dimmed.
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?= )/

const TAG_RE = /\[([^\]\n]+)\]/

// `useColor=false` returns the input verbatim; the contract that protects
// pipes, file redirects, NO_COLOR, and tests from ANSI leakage.
export function colorize(line: string, useColor: boolean): string {
  if (!useColor || line.length === 0) return line

  const ts = TIMESTAMP_RE.exec(line)
  const timestampLen = ts ? ts[0].length : 0
  const dimmedTimestamp = ts ? `${ANSI_DIM}${ts[0]}${ANSI_RESET}` : ''
  const rest = line.slice(timestampLen)

  const tag = TAG_RE.exec(rest)
  if (!tag) return `${dimmedTimestamp}${rest}`

  const tint = paletteColor(tag[1] ?? '')
  return `${dimmedTimestamp}${tint}${rest}${ANSI_RESET}`
}

function paletteColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return TAG_PALETTE[h % TAG_PALETTE.length] ?? TAG_PALETTE[0]
}

export function supportsColor(stream: NodeJS.WritableStream | NodeWritable): boolean {
  const tty = (stream as unknown as { isTTY?: boolean }).isTTY === true
  if (!tty) return false
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  return true
}
