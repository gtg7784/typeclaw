// Splits a Markdown document into chunks of bounded length while preserving
// the integrity of structural blocks that would render incorrectly if cut
// in the middle: code fences, tables, and (best-effort) blockquotes. The
// algorithm is intentionally a line-walker rather than a full Markdown
// parser — round-tripping through an AST normalizes whitespace and list
// markers, which would change the user-visible text and break byte-for-byte
// fidelity.
//
// Atomicity rules:
//   - Code fence (``` or ~~~): one atomic block. If a single fence exceeds
//     `maxLen`, it splits with the fence reopened on the next chunk so each
//     half is independently parseable.
//   - Pipe table (|---| separator on second line): one atomic block. If a
//     single table exceeds `maxLen`, it is emitted whole as one oversize
//     chunk — splitting a table is worse than downstream rejecting one
//     oversize message.
//   - Blockquote: one atomic block. Partial blockquotes look visually wrong
//     even when syntactically fine.
//   - Lists: packed as one block but splittable BETWEEN items if a single
//     list exceeds `maxLen`.
//   - Plain paragraphs: split on `\n\n` → `\n` → sentence → hard cut.

const FENCE_RE = /^(\s*)(```+|~~~+)(.*)$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/
const BLOCKQUOTE_RE = /^\s{0,3}>\s?/
const LIST_ITEM_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/
const FENCE_OVERHEAD_NEWLINES = 2

type Block = { kind: 'atomic' | 'list' | 'prose'; text: string }

export function chunkMarkdown(text: string, maxLen: number): string[] {
  if (!Number.isFinite(maxLen) || maxLen <= 0) {
    throw new Error(`chunkMarkdown: maxLen must be a positive finite number, got ${maxLen}`)
  }
  if (text === '') return ['']
  if (text.length <= maxLen) return [text]

  const blocks = tokenize(text)
  return packBlocks(blocks, maxLen)
}

function tokenize(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Close fence must use the same character (` vs ~) and be at least as
    // long as the opener; shorter closes are not closes per CommonMark.
    const fenceOpen = FENCE_RE.exec(line)
    if (fenceOpen !== undefined && fenceOpen !== null) {
      const fenceChar = fenceOpen[2]![0]!
      const fenceLen = fenceOpen[2]!.length
      const start = i
      i++
      while (i < lines.length) {
        const close = FENCE_RE.exec(lines[i]!)
        if (close && close[2]![0] === fenceChar && close[2]!.length >= fenceLen) {
          i++
          break
        }
        i++
      }
      blocks.push({ kind: 'atomic', text: lines.slice(start, i).join('\n') })
      continue
    }

    // We require the alignment row on line N+1 to disambiguate from prose
    // paragraphs that happen to contain a leading `|`.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!)) {
      const start = i
      i += 2
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        i++
      }
      blocks.push({ kind: 'atomic', text: lines.slice(start, i).join('\n') })
      continue
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const start = i
      while (i < lines.length && (BLOCKQUOTE_RE.test(lines[i]!) || lines[i]!.trim() === '')) {
        // A blank line followed by a non-blockquote line ends the quote.
        if (lines[i]!.trim() === '' && (i + 1 >= lines.length || !BLOCKQUOTE_RE.test(lines[i + 1]!))) {
          break
        }
        i++
      }
      blocks.push({ kind: 'atomic', text: lines.slice(start, i).join('\n') })
      continue
    }

    if (LIST_ITEM_RE.test(line)) {
      const start = i
      while (i < lines.length) {
        const cur = lines[i]!
        if (LIST_ITEM_RE.test(cur)) {
          i++
          continue
        }
        // Allow a single blank line inside a list (loose list); double blank ends.
        if (cur.trim() === '') {
          if (i + 1 < lines.length && LIST_ITEM_RE.test(lines[i + 1]!)) {
            i++
            continue
          }
          break
        }
        if (/^\s{2,}/.test(cur)) {
          i++
          continue
        }
        break
      }
      blocks.push({ kind: 'list', text: lines.slice(start, i).join('\n') })
      continue
    }

    const start = i
    while (i < lines.length && lines[i]!.trim() !== '') {
      i++
    }
    blocks.push({ kind: 'prose', text: lines.slice(start, i).join('\n') })
    while (i < lines.length && lines[i]!.trim() === '') {
      i++
    }
  }

  return blocks.filter((b) => b.text !== '')
}

function packBlocks(blocks: Block[], maxLen: number): string[] {
  const chunks: string[] = []
  let current = ''

  const flush = () => {
    if (current !== '') {
      chunks.push(current.replace(/\n+$/, ''))
      current = ''
    }
  }

  for (const block of blocks) {
    const sep = current === '' ? '' : '\n\n'
    const candidateLen = current.length + sep.length + block.text.length

    if (candidateLen <= maxLen) {
      current += sep + block.text
      continue
    }

    flush()

    if (block.text.length <= maxLen) {
      current = block.text
      continue
    }

    const split = splitOversize(block, maxLen)
    for (let i = 0; i < split.length - 1; i++) {
      chunks.push(split[i]!)
    }
    current = split[split.length - 1] ?? ''
  }

  flush()
  return chunks.length === 0 ? [''] : chunks
}

function splitOversize(block: Block, maxLen: number): string[] {
  if (block.kind === 'atomic') {
    return splitOversizeAtomic(block.text, maxLen)
  }
  if (block.kind === 'list') {
    return splitList(block.text, maxLen)
  }
  return splitProse(block.text, maxLen)
}

function splitOversizeAtomic(text: string, maxLen: number): string[] {
  // Fence splitting: re-emit the language tag on each chunk so syntax
  // highlighting survives the split.
  const openMatch = FENCE_RE.exec(text.split('\n')[0] ?? '')
  if (openMatch !== undefined && openMatch !== null) {
    const fenceMarker = openMatch[2]!
    const lang = openMatch[3] ?? ''
    const open = `${fenceMarker}${lang}`
    const close = fenceMarker

    const lines = text.split('\n')
    const innerStart = 1
    let innerEnd = lines.length
    if (innerEnd > innerStart) {
      const lastLine = lines[innerEnd - 1]!
      const lastClose = FENCE_RE.exec(lastLine)
      if (
        lastClose !== undefined &&
        lastClose !== null &&
        lastClose[2]![0] === fenceMarker[0] &&
        lastClose[2]!.length >= fenceMarker.length
      ) {
        innerEnd--
      }
    }
    const inner = lines.slice(innerStart, innerEnd).join('\n')
    const overhead = open.length + close.length + FENCE_OVERHEAD_NEWLINES
    if (overhead >= maxLen) {
      return [text]
    }
    const innerBudget = maxLen - overhead
    const innerChunks = splitProse(inner, innerBudget)
    return innerChunks.map((c) => `${open}\n${c}\n${close}`)
  }

  // Tables and other atomic blocks: keep whole, accept oversize.
  return [text]
}

function splitList(text: string, maxLen: number): string[] {
  const lines = text.split('\n')
  const items: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (LIST_ITEM_RE.test(line) && current.length > 0) {
      items.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) items.push(current.join('\n'))

  const chunks: string[] = []
  let buffer = ''
  for (const item of items) {
    const sep = buffer === '' ? '' : '\n'
    const candidateLen = buffer.length + sep.length + item.length
    if (candidateLen <= maxLen) {
      buffer += sep + item
      continue
    }
    if (buffer !== '') chunks.push(buffer)
    if (item.length <= maxLen) {
      buffer = item
    } else {
      const proseChunks = splitProse(item, maxLen)
      for (let i = 0; i < proseChunks.length - 1; i++) {
        chunks.push(proseChunks[i]!)
      }
      buffer = proseChunks[proseChunks.length - 1] ?? ''
    }
  }
  if (buffer !== '') chunks.push(buffer)
  return chunks
}

function splitProse(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]

  // Splitter array uses capturing groups so separators stay in the output
  // and we can rejoin without losing whitespace structure.
  const splitters: Array<(s: string) => string[]> = [
    (s) => s.split(/(\n\n+)/),
    (s) => s.split(/(\n)/),
    (s) => s.split(/(?<=[.!?])\s+/),
  ]

  for (const splitter of splitters) {
    const pieces = splitter(text)
    const merged = mergeWithBudget(pieces, maxLen)
    if (merged !== null) return merged
  }

  // Hard cut last resort: only fires when a single unbroken token exceeds maxLen.
  const out: string[] = []
  for (let i = 0; i < text.length; i += maxLen) {
    out.push(text.slice(i, i + maxLen))
  }
  return out
}

function mergeWithBudget(pieces: string[], maxLen: number): string[] | null {
  for (const p of pieces) {
    if (p.length > maxLen) return null
  }
  const chunks: string[] = []
  let buffer = ''
  for (const piece of pieces) {
    if (buffer.length + piece.length <= maxLen) {
      buffer += piece
      continue
    }
    if (buffer !== '') chunks.push(buffer)
    buffer = piece
  }
  if (buffer !== '') chunks.push(buffer)
  return chunks.map((c) => c.replace(/^\n+|\n+$/g, '')).filter((c) => c !== '')
}
