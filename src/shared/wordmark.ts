// Single source of truth for the "typeclaw" wordmark so the TUI banner and the
// init CLI render the same art instead of drifting apart. This module is
// color-agnostic: each consumer applies its own coloring layer (the TUI emits
// raw truecolor; init gates color behind NO_COLOR/TTY), so the art here carries
// zero escape sequences.

// ANSI Shadow "typeclaw". Trailing whitespace is significant for alignment.
export const WORDMARK_LINES: readonly string[] = [
  '████████╗██╗   ██╗██████╗ ███████╗ ██████╗██╗      █████╗ ██╗    ██╗',
  '╚══██╔══╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔════╝██║     ██╔══██╗██║    ██║',
  '   ██║    ╚████╔╝ ██████╔╝█████╗  ██║     ██║     ███████║██║ █╗ ██║',
  '   ██║     ╚██╔╝  ██╔═══╝ ██╔══╝  ██║     ██║     ██╔══██║██║███╗██║',
  '   ██║      ██║   ██║     ███████╗╚██████╗███████╗██║  ██║╚███╔███╔╝',
  '   ╚═╝      ╚═╝   ╚═╝     ╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ',
]

export const WORDMARK_WIDTH: number = Math.max(...WORDMARK_LINES.map((line) => line.length))

export const COMPACT_WORDMARK = 'typeclaw'
