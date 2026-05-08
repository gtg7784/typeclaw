// Convert the model's common-Markdown output to valid Telegram MarkdownV2.
//
// Why this exists: the agent writes Markdown the way a human would type
// it (`**bold**`, `*italic*`, `` `code` ``, fenced blocks, `[text](url)`).
// Telegram's MarkdownV2 parser is unforgiving — any unescaped special
// char (`_*[]()~``>#+-=|{}.!\`) outside an entity returns
// `Bad Request: can't parse entities` and the whole message is rejected.
// A plain-text send keeps the message intact at the cost of literal
// `**bold**` artifacts; HTML-mode would still need every `<&>` escaped.
// MarkdownV2 with smart escaping is the only mode where the agent gets
// rendered formatting AND raw user text never crashes the parser.
//
// Strategy: walk the source, recognize a small fixed set of inline and
// block constructs, emit MarkdownV2 with the right escape rules per
// region. Anything we don't recognize (headings, list markers, blockquote
// arrows, raw special chars) falls through as escaped literal text —
// MarkdownV2 has no native heading or list rendering anyway, so this
// matches what Telegram can actually display rather than failing.
//
// Telegram entity rules (https://core.telegram.org/bots/api#markdownv2-style):
//   - Outside entities: escape `_ * [ ] ( ) ~ ` > # + - = | { } . !`.
//     Backslash is the escape char, so a literal `\` must be `\\`.
//   - Inside `code` / `pre`: escape `` ` `` and `\` only — every other
//     special char is literal.
//   - Inside link `(url)`: escape `)` and `\` only.
//   - Inside link `[text]`: full outside-entity rules apply.

const SPECIAL_CHARS_OUTSIDE = /[_*[\]()~`>#+\-=|{}.!\\]/g
const SPECIAL_CHARS_CODE = /[`\\]/g
const SPECIAL_CHARS_LINK_URL = /[)\\]/g

export function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL_CHARS_OUTSIDE, '\\$&')
}

function escapeCodeContent(text: string): string {
  return text.replace(SPECIAL_CHARS_CODE, '\\$&')
}

function escapeLinkUrl(url: string): string {
  return url.replace(SPECIAL_CHARS_LINK_URL, '\\$&')
}

// Public entry point. Takes the agent's raw text (common Markdown) and
// returns a string safe to send with `parse_mode: 'MarkdownV2'`. The
// returned string is guaranteed never to crash Telegram's parser for any
// input the agent could plausibly produce — the conversion is best-effort
// for formatting and total for safety.
export function toTelegramMarkdownV2(input: string): string {
  // Block pass first: pull out fenced code blocks so their contents are
  // never re-tokenized as inline constructs (a `*` inside ```code``` is
  // literal, not italic). The remaining text goes through the inline
  // tokenizer.
  const out: string[] = []
  let i = 0
  while (i < input.length) {
    if (matchesAt(input, i, '```')) {
      const fenceEnd = findFenceEnd(input, i + 3)
      if (fenceEnd !== -1) {
        const inner = input.slice(i + 3, fenceEnd)
        out.push(renderFence(inner))
        i = fenceEnd + 3
        continue
      }
      // Unterminated fence — render the rest of the input as escaped
      // inline (the open backticks become `\`\`\`` literals) so we
      // never infinite-loop on `nextFence === i` and never swallow the
      // rest of the message.
      out.push(renderInline(input.slice(i)))
      break
    }
    const nextFence = input.indexOf('```', i)
    const segmentEnd = nextFence === -1 ? input.length : nextFence
    out.push(renderInline(input.slice(i, segmentEnd)))
    i = segmentEnd
  }
  return out.join('')
}

function matchesAt(s: string, idx: number, needle: string): boolean {
  return s.slice(idx, idx + needle.length) === needle
}

function findFenceEnd(s: string, start: number): number {
  // Telegram pre-blocks don't nest, so the first ``` after `start` is the
  // close. We do not require it to be on its own line — the agent often
  // emits ` ```python\ncode``` ` inline.
  return s.indexOf('```', start)
}

function renderFence(inner: string): string {
  // Optional language hint on the first line (` ```python\n... ``` `).
  // MarkdownV2 supports it as `\`\`\`<lang>\n...\`\`\``. Strip the
  // newline immediately after the language if present, and also strip a
  // bare leading newline (` ```\nbody\n``` `) so the rendered block
  // doesn't carry an extra empty first line.
  let lang = ''
  let body = inner
  const newline = inner.indexOf('\n')
  if (newline !== -1) {
    const candidate = inner.slice(0, newline).trim()
    if (candidate !== '' && /^[A-Za-z0-9_+\-.]+$/.test(candidate)) {
      lang = candidate
      body = inner.slice(newline + 1)
    } else if (candidate === '') {
      body = inner.slice(newline + 1)
    }
  }
  if (body.endsWith('\n')) body = body.slice(0, -1)
  const escapedBody = escapeCodeContent(body)
  return lang === '' ? '```\n' + escapedBody + '\n```' : '```' + lang + '\n' + escapedBody + '\n```'
}

// Inline tokenizer. Recognizes (in priority order):
//   1. Inline code:  `code`
//   2. Links:        [text](url)
//   3. Bold:         **text**  or  __text__
//   4. Strikethrough:~~text~~
//   5. Spoiler:      ||text||
//   6. Italic:       *text*  or  _text_
//
// Italic is checked LAST because `**` would otherwise be eaten as two
// italic markers. Underscore italic / underscore bold collapse to the
// asterisk forms because MarkdownV2 reserves `_` for italic and `__` for
// underline — using `_` for italic and `*` for bold sidesteps the
// underline-vs-italic ambiguity.
function renderInline(text: string): string {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    if (ch === '`') {
      const close = text.indexOf('`', i + 1)
      if (close !== -1) {
        const inner = text.slice(i + 1, close)
        out.push('`' + escapeCodeContent(inner) + '`')
        i = close + 1
        continue
      }
    }

    if (ch === '[') {
      const link = parseLink(text, i)
      if (link !== null) {
        const renderedText = renderInline(link.label)
        out.push('[' + renderedText + '](' + escapeLinkUrl(link.url) + ')')
        i = link.end
        continue
      }
    }

    // Paired markers (bold/strike/spoiler): empty content is rejected
    // by Telegram as an empty entity, so collapse `****` etc. to escaped
    // literals rather than emit zero-width entities.
    if (ch === '*' && text[i + 1] === '*') {
      const close = findClose(text, i + 2, '**')
      if (close !== -1 && close > i + 2) {
        const inner = text.slice(i + 2, close)
        out.push('*' + renderInline(inner) + '*')
        i = close + 2
        continue
      }
    }
    if (ch === '_' && text[i + 1] === '_' && !isWordChar(text[i - 1])) {
      // `__bold__` only when the open marker is not adjacent to a word
      // char on the LEFT (`my__var__name` is a snake_case identifier the
      // model accidentally wrote, not bold). The close marker is
      // checked for the same on its RIGHT side below.
      const close = findClose(text, i + 2, '__')
      if (close !== -1 && close > i + 2 && !isWordChar(text[close + 2])) {
        const inner = text.slice(i + 2, close)
        out.push('*' + renderInline(inner) + '*')
        i = close + 2
        continue
      }
    }

    if (ch === '~' && text[i + 1] === '~') {
      const close = findClose(text, i + 2, '~~')
      if (close !== -1 && close > i + 2) {
        const inner = text.slice(i + 2, close)
        out.push('~' + renderInline(inner) + '~')
        i = close + 2
        continue
      }
    }

    if (ch === '|' && text[i + 1] === '|') {
      const close = findClose(text, i + 2, '||')
      if (close !== -1 && close > i + 2) {
        const inner = text.slice(i + 2, close)
        out.push('||' + renderInline(inner) + '||')
        i = close + 2
        continue
      }
    }

    // Italic: word-boundary guard on BOTH sides — `a*b*c` and
    // `var_name` must NOT italicize. The model emits literal
    // asterisks/underscores in math, code references, and identifiers.
    if (ch === '*' && !isWordChar(text[i - 1])) {
      const close = findInlineClose(text, i + 1, '*')
      if (close !== -1 && !isWordChar(text[close + 1])) {
        const inner = text.slice(i + 1, close)
        if (inner !== '' && !/^\s|\s$/.test(inner)) {
          out.push('_' + renderInline(inner) + '_')
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
          out.push('_' + renderInline(inner) + '_')
          i = close + 1
          continue
        }
      }
    }

    out.push(SPECIAL_CHARS_OUTSIDE.test(ch) ? '\\' + ch : ch)
    SPECIAL_CHARS_OUTSIDE.lastIndex = 0
    i++
  }
  return out.join('')
}

function findClose(text: string, from: number, marker: string): number {
  // Find the next occurrence of `marker` at or after `from` that is NOT
  // preceded by a backslash escape. Used for paired `**` / `__` / `~~` /
  // `||`. A line break inside a marker pair is allowed — the model often
  // emits multi-line bold.
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
  // Same as findClose but stops at line breaks — used for single-marker
  // italic so a stray `*` doesn't stretch across paragraphs.
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
  // `[label](url)` — labels can contain anything but unescaped `]`,
  // urls anything but unescaped `)`. Newlines inside either part
  // disqualify the match (the model meant a literal bracket, not a link).
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
    // An unescaped `(` makes the close-paren ambiguous (Wikipedia
    // links like `Foo_(bar)` would close on the inner `)` and emit
    // mangled MarkdownV2). Drop the link match and let the bracket
    // chars fall through escaped — the URL still appears as plain
    // text, just not as a clickable link.
    if (c === '(') return null
    if (c === '\n') return null
    j++
  }
  if (text[j] !== ')') return null
  const url = text.slice(urlStart, j)
  return { label, url, end: j + 1 }
}

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return /[A-Za-z0-9_]/.test(ch)
}
