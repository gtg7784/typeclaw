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
      const cellLen = row[c]!.length
      if (widths[c] === undefined || cellLen > widths[c]!) {
        widths[c] = cellLen
      }
    }
  }
  return widths
}

function padRow(cells: string[], widths: number[]): string {
  const padded = widths.map((width, c) => (cells[c] ?? '').padEnd(width))
  // Two spaces between columns keeps them visually distinct inside the
  // monospaced span without a vertical-bar separator.
  return padded.join('  ')
}

function wrapCode(text: string): string {
  return `\`${text}\``
}
