// Discord renders no GitHub-flavored Markdown tables — a `| a | b |` block
// shows up as literal pipes and dashes, so an agent reply that leans on a table
// (very common) becomes unreadable. Discord DOES preserve whitespace verbatim
// inside inline code spans, so we re-emit each table row as a single
// backtick-wrapped line with columns padded to a fixed width. Columns line up
// because every row is the same monospaced inline-code span. The header row is
// additionally wrapped in `**...**` so it reads as a bold caption above the body.
//
// This is a line-walker, not a Markdown parser: it only touches blocks that
// match the pipe-table shape (a `|`-bearing line followed by a `|---|` alignment
// row) and leaves every other byte — prose, code fences, lists — untouched.

const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/
const FENCE_RE = /^(\s*)(```+|~~~+)(.*)$/

export function convertDiscordTables(input: string): string {
  if (input === '') return ''
  if (!input.includes('|')) return input

  const lines = input.split('\n')
  const out: string[] = []
  let i = 0
  let openFence: string | null = null

  while (i < lines.length) {
    const line = lines[i]!

    // A code fence (``` / ~~~) suspends table detection until it closes — a
    // table-shaped block inside a fence is literal text, not a table. The close
    // must use the same fence char and be at least as long as the opener, per
    // CommonMark.
    const fence = FENCE_RE.exec(line)
    if (fence !== null) {
      const marker = fence[2]!
      if (openFence === null) {
        openFence = marker
      } else if (marker[0] === openFence[0] && marker.length >= openFence.length) {
        openFence = null
      }
      out.push(line)
      i++
      continue
    }
    if (openFence !== null) {
      out.push(line)
      i++
      continue
    }

    // A table needs a `|`-bearing header line immediately followed by the
    // alignment row; same disambiguation rule chunkMarkdown uses so a stray
    // leading `|` in prose is not mistaken for a table.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!)) {
      const start = i
      i += 2
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        i++
      }
      const tableLines = lines.slice(start, i)
      out.push(renderTable(tableLines))
      continue
    }
    out.push(line)
    i++
  }

  return out.join('\n')
}

function renderTable(tableLines: string[]): string {
  const headerCells = splitRow(tableLines[0]!)
  const bodyRows = tableLines.slice(2).map(splitRow)
  const widths = computeWidths([headerCells, ...bodyRows])

  const header = wrapCode(padRow(headerCells, widths))
  const renderedRows = [`**${header}**`, ...bodyRows.map((cells) => wrapCode(padRow(cells, widths)))]
  return renderedRows.join('\n')
}

function splitRow(row: string): string[] {
  // Trim one optional leading/trailing pipe, then split on the rest. A trailing
  // backslash before a pipe escapes it, but GFM table escaping is rare in agent
  // output — we keep it simple and split on bare pipes.
  let trimmed = row.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map((cell) => cell.trim())
}

function computeWidths(rows: string[][]): number[] {
  const columnCount = Math.max(0, ...rows.map((row) => row.length))
  return Array.from({ length: columnCount }, (_, c) => Math.max(0, ...rows.map((row) => displayWidth(row[c] ?? ''))))
}

function padRow(cells: string[], widths: number[]): string {
  const pads = computePads(cells, widths)
  // Two spaces between columns keeps them visually distinct inside the
  // monospaced span without a vertical-bar separator.
  return widths.map((_, c) => (cells[c] ?? '') + ' '.repeat(pads[c]!)).join('  ')
}

// Column widths are fractional (a CJK glyph is 1.7), but padding inserts whole
// spaces. Rounding each cell's deficit independently lets per-row rounding error
// accumulate, so rows drift apart. Instead we round the ROW's total deficit once
// and hand out the integer spaces by largest fractional remainder (Hamilton
// apportionment). This bounds every rendered row to within 0.5 visual units of
// the ideal width, so any two rows differ by at most ~1 space — the tightest
// alignment achievable with whole-space padding.
const REMAINDER_EPSILON = 1e-9

function computePads(cells: string[], widths: number[]): number[] {
  const deficits = widths.map((width, c) => Math.max(0, width - displayWidth(cells[c] ?? '')))
  const basePads = deficits.map((d) => Math.floor(d))
  const baseTotal = basePads.reduce((sum, p) => sum + p, 0)
  const desiredTotal = Math.round(deficits.reduce((sum, d) => sum + d, 0))

  let extras = desiredTotal - baseTotal
  const byRemainder = deficits
    .map((d, index) => ({ index, remainder: d - Math.floor(d) }))
    .filter((item) => item.remainder > REMAINDER_EPSILON)
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)

  const pads = [...basePads]
  for (const { index } of byRemainder) {
    if (extras <= 0) break
    pads[index]!++
    extras--
  }
  return pads
}

// Discord's monospaced inline-code font renders CJK ideographs, full-width
// punctuation, and most emoji WIDER than a latin glyph, while combining/
// zero-width marks take none. `String.prototype.padEnd` counts UTF-16 code
// units, so padding by `.length` leaves wide-character tables visually ragged.
// We iterate by code point and sum per-glyph column widths so every cell pads
// to (near) the same VISUAL width. The ranges below are the standard
// East-Asian-Wide / Wide blocks plus the common emoji planes.
//
// The wide multiplier is 1.7, not the textbook wcwidth value of 2: Discord's
// proportional code font renders a Hangul/CJK glyph at roughly 1.7x a latin
// monospace cell, so charging 2 over-pads CJK columns and leaves them visibly
// too wide. Because `displayWidth` is now fractional, padding (which can only
// insert whole spaces) is apportioned at the row level — see `padRow`.
const WIDE_CHAR_WIDTH = 1.7

export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    width += charWidth(ch.codePointAt(0)!)
  }
  return width
}

function charWidth(cp: number): number {
  if (isZeroWidth(cp)) return 0
  if (isWide(cp)) return WIDE_CHAR_WIDTH
  return 1
}

function isZeroWidth(cp: number): boolean {
  return (
    cp === 0x200b || // zero-width space
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x200c && cp <= 0x200f) || // ZWNJ/ZWJ/directional marks
    (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
  )
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x2600 && cp <= 0x26ff) || // Miscellaneous Symbols (☀ ♻ ⚠ …)
    (cp >= 0x2700 && cp <= 0x27bf) || // Dingbats (✅ ✔ ✨ ➡ …)
    (cp >= 0x2b00 && cp <= 0x2bff) || // Misc Symbols and Arrows (⭐ …)
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji, symbols, pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+ (supplementary ideographic)
  )
}

// CommonMark inline code: the delimiter must be a backtick run LONGER than any
// run inside the content, otherwise an embedded `` ` `` (e.g. a cell holding
// `bun test`) closes the span early and corrupts the row. When the content
// begins or ends with a backtick, one space of padding is inserted on each side
// so the delimiter is not adjacent to a content backtick; CommonMark strips that
// single padding space on render, leaving our column widths intact.
function wrapCode(text: string): string {
  const fence = '`'.repeat(longestBacktickRun(text) + 1)
  const needsPad = text.startsWith('`') || text.endsWith('`')
  const pad = needsPad ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

function longestBacktickRun(text: string): number {
  let longest = 0
  let run = 0
  for (const ch of text) {
    if (ch === '`') {
      run++
      if (run > longest) longest = run
    } else {
      run = 0
    }
  }
  return longest
}
