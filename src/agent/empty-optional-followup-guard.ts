const ENGLISH_OPTIONAL_FOLLOWUP_START =
  /^\s*(?:[-*]\s*)?(?:if\s+you\s+(?:want|would\s+like|need)|if\s+you'd\s+like|if\s+helpful|let\s+me\s+know\s+if\s+you\s+(?:want|would\s+like|need))\b/i
const KOREAN_OPTIONAL_FOLLOWUP_START =
  /^\s*(?:[-*]\s*)?(?:(?:원하시면|원하면|필요하면|필요하시면)|(?:더\s*)?필요(?:한|하신)\s*(?:게|것이)\s*있(?:으면|으시면))/

const ACTION_WORDS = [
  'can',
  'could',
  'want',
  'would',
  'need',
  'like',
  'share',
  'send',
  'draft',
  'add',
  'make',
  'help',
  'walk',
  'explain',
  'summarize',
  'provide',
  'show',
]

/**
 * Removes empty optional follow-up filler from the tail of a user-visible reply.
 *
 * The guard is intentionally tail-only and CTA-shaped: it strips standalone
 * sentences/paragraphs such as "If you want, I can also ..." and "원하면 ...".
 * It does not remove ordinary conditionals in substantive content, especially
 * non-tail sentences like "If the webhook is disabled, restart is required."
 */
export function stripEmptyOptionalFollowupFiller(text: string): string {
  let body = trimTrailingWhitespace(text)
  let changed = false

  while (body.length > 0) {
    const candidate = trailingSentenceOrParagraph(body)
    if (candidate === null) break
    if (!isEmptyOptionalFollowup(candidate.text)) break
    body = candidate.before.trimEnd()
    changed = true
  }

  return changed ? body : text
}

function trimTrailingWhitespace(text: string): string {
  const trailing = text.match(/\s*$/)?.[0] ?? ''
  return text.slice(0, text.length - trailing.length)
}

function trailingSentenceOrParagraph(text: string): { before: string; text: string } | null {
  const paragraphMatch = text.match(/\n\s*\n(?![\s\S]*\n\s*\n)/)
  if (paragraphMatch?.index !== undefined) {
    const start = paragraphMatch.index + paragraphMatch[0].length
    return { before: text.slice(0, paragraphMatch.index), text: text.slice(start).trim() }
  }

  const boundary = findPreviousSentenceBoundary(text)
  if (boundary === -1) return { before: '', text: text.trim() }
  return { before: text.slice(0, boundary + 1), text: text.slice(boundary + 1).trim() }
}

function findPreviousSentenceBoundary(text: string): number {
  for (let i = text.length - 2; i >= 0; i--) {
    const ch = text[i]
    if (
      (ch === '.' || ch === '!' || ch === '?' || ch === '。' || ch === '！' || ch === '？') &&
      /\s/.test(text[i + 1] ?? '')
    ) {
      return i
    }
  }
  return -1
}

function isEmptyOptionalFollowup(sentence: string): boolean {
  const normalized = sentence.trim()
  if (normalized.length === 0) return false
  if (KOREAN_OPTIONAL_FOLLOWUP_START.test(normalized)) return true
  if (!ENGLISH_OPTIONAL_FOLLOWUP_START.test(normalized)) return false
  return ACTION_WORDS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(normalized))
}
