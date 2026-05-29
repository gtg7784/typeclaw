// KakaoTalk's LOCO protocol renders no rich text — bytes display verbatim, so
// the agent's Markdown (`**bold**`, `### heading`, fenced ```blocks```) leaks
// literal `*`/`#`/backtick noise into the chat. This strips the formatting
// markers and keeps the content. Mirrors telegram-bot-format.ts, but emits
// plain content instead of re-encoding to MarkdownV2. Links collapse to
// `label (url)` so the destination survives; list/quote markers stay (they
// read fine unrendered).

export function toKakaoPlainText(input: string): string {
  // Pull fenced code out first so a `*` inside a block is not re-tokenized as
  // italic.
  const out: string[] = []
  let i = 0
  while (i < input.length) {
    if (matchesAt(input, i, '```')) {
      const fenceEnd = findFenceEnd(input, i + 3)
      if (fenceEnd !== -1) {
        out.push(renderFence(input.slice(i + 3, fenceEnd)))
        i = fenceEnd + 3
        continue
      }
      // Unterminated fence — strip the open backticks and render the rest
      // inline so we never infinite-loop and never drop the tail.
      out.push(renderInline(stripLeadingFence(input.slice(i + 3))))
      break
    }
    const nextFence = input.indexOf('```', i)
    const segmentEnd = nextFence === -1 ? input.length : nextFence
    out.push(renderLines(input.slice(i, segmentEnd)))
    i = segmentEnd
  }
  return out.join('')
}

function matchesAt(s: string, idx: number, needle: string): boolean {
  return s.slice(idx, idx + needle.length) === needle
}

function findFenceEnd(s: string, start: number): number {
  return s.indexOf('```', start)
}

function stripLeadingFence(inner: string): string {
  // Drop an optional language hint and the newline after an opening fence.
  const newline = inner.indexOf('\n')
  if (newline === -1) return inner
  const candidate = inner.slice(0, newline).trim()
  if (candidate === '' || /^[A-Za-z0-9_+\-.]+$/.test(candidate)) {
    return inner.slice(newline + 1)
  }
  return inner
}

function renderFence(inner: string): string {
  // Keep the code body verbatim, drop the fences and any language hint.
  let body = inner
  const newline = inner.indexOf('\n')
  if (newline !== -1) {
    const candidate = inner.slice(0, newline).trim()
    if (candidate === '' || /^[A-Za-z0-9_+\-.]+$/.test(candidate)) {
      body = inner.slice(newline + 1)
    }
  }
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return body
}

// Strip per-line block markers (heading hashes, blockquote arrows) before
// running the inline tokenizer on each line. List markers (`- `, `* `, `1.`)
// are left intact — they read fine as plain text and signal structure.
function renderLines(text: string): string {
  const lines = text.split('\n')
  const rendered = lines.map((line) => renderInline(stripBlockMarkers(line)))
  return rendered.join('\n')
}

function stripBlockMarkers(line: string): string {
  // `### heading` → `heading`; `> quote` → `quote`. Only acts on leading
  // markers after optional indentation so mid-line `#`/`>` stay literal.
  const heading = /^(\s*)#{1,6}\s+(.*)$/.exec(line)
  if (heading !== null) return heading[1]! + heading[2]!
  const quote = /^(\s*)>\s?(.*)$/.exec(line)
  if (quote !== null) return quote[1]! + quote[2]!
  return line
}

// Inline tokenizer. Recognizes (in priority order):
//   1. Inline code:   `code`        → code
//   2. Links:         [text](url)   → text (url)
//   3. Bold:          **text** / __text__ → text
//   4. Strikethrough: ~~text~~      → text
//   5. Italic:        *text* / _text_     → text
//
// Bold is checked before italic so `**` is not eaten as two italic markers.
// Word-boundary guards keep snake_case identifiers and `a*b` math from being
// mistaken for emphasis — the same rules the Telegram formatter uses.
function renderInline(text: string): string {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    if (ch === '`') {
      const close = text.indexOf('`', i + 1)
      if (close !== -1) {
        out.push(text.slice(i + 1, close))
        i = close + 1
        continue
      }
    }

    if (ch === '[') {
      const link = parseLink(text, i)
      if (link !== null) {
        const label = renderInline(link.label)
        out.push(link.url === '' ? label : `${label} (${link.url})`)
        i = link.end
        continue
      }
    }

    if (ch === '*' && text[i + 1] === '*') {
      const close = findClose(text, i + 2, '**')
      if (close !== -1 && close > i + 2) {
        out.push(renderInline(text.slice(i + 2, close)))
        i = close + 2
        continue
      }
    }
    if (ch === '_' && text[i + 1] === '_' && !isWordChar(text[i - 1])) {
      const close = findClose(text, i + 2, '__')
      if (close !== -1 && close > i + 2 && !isWordChar(text[close + 2])) {
        out.push(renderInline(text.slice(i + 2, close)))
        i = close + 2
        continue
      }
    }

    if (ch === '~' && text[i + 1] === '~') {
      const close = findClose(text, i + 2, '~~')
      if (close !== -1 && close > i + 2) {
        out.push(renderInline(text.slice(i + 2, close)))
        i = close + 2
        continue
      }
    }

    if (ch === '*' && !isWordChar(text[i - 1])) {
      const close = findInlineClose(text, i + 1, '*')
      if (close !== -1 && !isWordChar(text[close + 1])) {
        const inner = text.slice(i + 1, close)
        if (inner !== '' && !/^\s|\s$/.test(inner)) {
          out.push(renderInline(inner))
          i = close + 1
          continue
        }
      }
    }
    if (ch === '_' && !isWordChar(text[i - 1])) {
      const close = findInlineClose(text, i + 1, '_')
      if (close !== -1 && !isWordChar(text[close + 1])) {
        const inner = text.slice(i + 1, close)
        if (inner !== '' && !/^\s|\s$/.test(inner)) {
          out.push(renderInline(inner))
          i = close + 1
          continue
        }
      }
    }

    out.push(ch)
    i++
  }
  return out.join('')
}

function findClose(text: string, from: number, marker: string): number {
  let i = from
  while (i <= text.length - marker.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (matchesAt(text, i, marker)) return i
    i++
  }
  return -1
}

function findInlineClose(text: string, from: number, marker: string): number {
  let i = from
  while (i < text.length) {
    if (text[i] === '\n') return -1
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (matchesAt(text, i, marker)) return i
    i++
  }
  return -1
}

function parseLink(text: string, start: number): { label: string; url: string; end: number } | null {
  let i = start + 1
  const labelStart = i
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === ']') break
    if (c === '\n') return null
    i++
  }
  if (text[i] !== ']' || text[i + 1] !== '(') return null
  const label = text.slice(labelStart, i)
  const urlStart = i + 2
  let j = urlStart
  while (j < text.length) {
    const c = text[j]!
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === ')') break
    if (c === '(') return null
    if (c === '\n') return null
    j++
  }
  if (text[j] !== ')') return null
  return { label, url: text.slice(urlStart, j), end: j + 1 }
}

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return /[A-Za-z0-9_]/.test(ch)
}
