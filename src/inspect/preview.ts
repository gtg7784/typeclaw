import type { MinimalSessionOrigin } from '@/agent/session-meta'

// Builds the one-line session-list hint from a session's first user turn.
// User turns are wrapped in runtime-injected preamble (<current-time>, role
// anchors, SYSTEM MESSAGE fences, channel context sections, …) that grows over
// time. Rather than chase every block, this keys off stable semantic
// boundaries and prefers null over a misleading hint — it is a cosmetic glance,
// not a faithful reconstruction.
export function previewForHint(origin: MinimalSessionOrigin | null, text: string): string | null {
  // A subagent's first message is a machine payload (Parent session:, …) and
  // the row label already names the subagent.
  if (origin?.kind === 'subagent') return null
  if (origin?.kind === 'channel') return channelPreview(text)
  return structuralPreview(text)
}

// `[ISO] <@authorId> (authorName) [bot]: actual text` — the only line carrying
// human-typed text in a channel turn. The stamp is omitted when ts<=0, so it is
// optional here; name and bot tag are also optional.
const AUTHOR_LINE = /^(?:\[[^\]]+\]\s+)?<[^>]+>(?:\s+\([^)]+\))?(?:\s+\[bot\])?:\s*(.*)$/

const CURRENT_MESSAGE_HEADER = /^## Current messages? \(addressed to you\)\s*$/

// Channel preview: extract ONLY from the "## Current message(s) (addressed to
// you)" section — never the "## Recent context" section above it, which is other
// people's messages the agent was only made aware of. Returns null if no
// addressed message is found.
function channelPreview(text: string): string | null {
  const lines = text.split('\n')
  const headerIdx = lines.findIndex((l) => CURRENT_MESSAGE_HEADER.test(l))
  if (headerIdx === -1) return null

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const match = AUTHOR_LINE.exec(lines[i]!)
    if (match === null) continue
    const payload = collectMessage(match[1] ?? '', lines, i + 1)
    const trimmed = payload.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

// An author line's text plus any continuation lines (a multi-line message
// continues without the author prefix) until the next author line, a structural
// boundary (## / ---), or a quote anchor (>).
function collectMessage(first: string, lines: string[], start: number): string {
  const parts = [first]
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    if (AUTHOR_LINE.test(line) || line.startsWith('## ') || line.startsWith('---') || line.startsWith('>')) break
    parts.push(line)
  }
  return parts.join(' ')
}

// Origin-agnostic fallback (TUI, cron, system, unknown): skip leading injected
// structure — XML-tag blocks, `--- … ---` SYSTEM MESSAGE fences, `## …`
// sections, and blank lines — then take the first remaining real line. This
// degrades gracefully as new runtime notices (which follow the same framing
// conventions) are added, without needing per-block updates.
function structuralPreview(text: string): string | null {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed === '') {
      i++
    } else if (trimmed.startsWith('<')) {
      i = skipXmlOrTagLine(lines, i)
    } else if (trimmed.startsWith('---')) {
      i = skipFence(lines, i)
    } else if (trimmed.startsWith('#')) {
      i++
    } else {
      return looksInjected(trimmed) ? null : trimmed
    }
  }
  return null
}

// Skips a leading XML block. If the opening tag closes on the same line or
// spans lines, advance past the matching close tag; otherwise skip just the one
// line (a stray `<…>` shouldn't swallow the rest).
function skipXmlOrTagLine(lines: string[], start: number): number {
  const open = /^<([a-zA-Z][\w-]*)/.exec(lines[start]!.trim())
  if (open === null) return start + 1
  const close = `</${open[1]}>`
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.includes(close)) return i + 1
  }
  return start + 1
}

// Skips a `---` fenced block (SYSTEM MESSAGE framing): from the opening `---`
// to the next standalone `---`.
function skipFence(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') return i + 1
  }
  return start + 1
}

function looksInjected(line: string): boolean {
  return line.startsWith('**[SYSTEM') || line.startsWith('[security/')
}
