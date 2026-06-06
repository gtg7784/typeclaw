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

export function convertDiscordTables(input: string): string {
  if (input === '') return ''
  if (!input.includes('|')) return input

  const lines = input.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
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
  const widths: number[] = []
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const cellWidth = displayWidth(row[c]!)
      if (widths[c] === undefined || cellWidth > widths[c]!) {
        widths[c] = cellWidth
      }
    }
  }
  return widths
}

function padRow(cells: string[], widths: number[]): string {
  const padded = widths.map((width, c) => padToWidth(cells[c] ?? '', width))
  // Two spaces between columns keeps them visually distinct inside the
  // monospaced span without a vertical-bar separator.
  return padded.join('  ')
}

function padToWidth(cell: string, width: number): string {
  const pad = width - displayWidth(cell)
  return pad > 0 ? cell + ' '.repeat(pad) : cell
}

// Discord's monospaced inline-code font renders CJK ideographs, full-width
// punctuation, and most emoji at two columns, while combining/zero-width marks
// take none. `String.prototype.padEnd` counts UTF-16 code units, so padding by
// `.length` leaves wide-character tables visually ragged. We iterate by code
// point and sum per-glyph column widths so every cell pads to the same VISUAL
// width. The ranges below are the standard East-Asian-Wide / Wide blocks plus
// the common emoji planes; this is the same wcwidth approximation editors use.
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    width += charWidth(ch.codePointAt(0)!)
  }
  return width
}

function charWidth(cp: number): number {
  if (isZeroWidth(cp)) return 0
  if (isWide(cp)) return 2
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

function wrapCode(text: string): string {
  return `\`${text}\``
}
