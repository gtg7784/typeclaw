import type { WebexMessage } from 'agent-messenger/webex'

// Webex's E2E (internal conversation) path renders agent markdown as an HTML
// `content` field that some clients display verbatim, so messages sent with
// `markdown: true` leak literal `<br/>` and `&apos;`. typeclaw sends plain text
// outbound; inbound we still read the HTML `html` field as a fallback, so this
// undoes that HTML. Protocol HTML (not natural language) -> ASCII literal set.

// Normalize ONLY the HTML `html` fallback: `text`/`markdown` are author-clean and
// must stay raw, or literal `&`/`<` the user typed would be corrupted.
export function resolveWebexBodyText(msg: Pick<WebexMessage, 'text' | 'markdown' | 'html'>): string {
  if (msg.text !== undefined && msg.text !== '') return msg.text
  if (msg.markdown !== undefined && msg.markdown !== '') return msg.markdown
  if (msg.html !== undefined && msg.html !== '') return normalizeWebexHtmlFallbackText(msg.html)
  return ''
}

export function normalizeWebexHtmlFallbackText(value: string): string {
  const withBreaks = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/?[^>]+>/g, '')
  return decodeHtmlEntities(withBreaks)
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) return codePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return codePoint(Number.parseInt(lower.slice(1), 10))
    switch (lower) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'nbsp':
        return ' '
      default:
        return match
    }
  })
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return ''
  return String.fromCodePoint(value)
}
