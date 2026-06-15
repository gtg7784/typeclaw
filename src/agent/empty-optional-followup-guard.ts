type OptionalFollowupPattern = {
  start: RegExp
  requiresAssistantOffer?: boolean
}

const OPTIONAL_FOLLOWUP_PATTERNS: OptionalFollowupPattern[] = [
  // English
  {
    start:
      /^\s*(?:[-*]\s*)?(?:if\s+you\s+(?:want|would\s+like|need)|if\s+you'd\s+like|if\s+helpful|let\s+me\s+know\s+if\s+you\s+(?:want|would\s+like|need))\b/i,
    requiresAssistantOffer: true,
  },
  // Korean
  {
    start:
      /^\s*(?:[-*]\s*)?(?:(?:원하시면|원하면|필요하면|필요하시면)|(?:더\s*)?필요(?:한|하신)\s*(?:게|것이)\s*있(?:으면|으시면))/,
  },
  // Japanese
  { start: /^\s*(?:[-*]\s*)?(?:必要(?:でし)?たら|ご希望(?:でし)?たら|よろしければ|もし必要(?:でし)?たら)/ },
  // Chinese (Simplified/Traditional)
  { start: /^\s*(?:[-*]\s*)?(?:如果(?:你|您)?(?:需要|想要|愿意|願意)|如(?:需|果需要)|需要的话|需要的話)/ },
  // Spanish
  {
    start:
      /^\s*(?:[-*]\s*)?(?:si\s+(?:quieres|quiere|necesitas|necesita|te\s+sirve|le\s+sirve)|si\s+te\s+resulta\s+útil)/i,
  },
  // French
  {
    start:
      /^\s*(?:[-*]\s*)?(?:si\s+(?:tu\s+veux|vous\s+voulez|tu\s+as\s+besoin|vous\s+avez\s+besoin|besoin)|si\s+c['’]est\s+utile)/i,
  },
  // German
  {
    start:
      /^\s*(?:[-*]\s*)?(?:wenn\s+du\s+(?:möchtest|willst|brauchst)|wenn\s+sie\s+(?:möchten|wollen|brauchen)|falls\s+(?:du|sie)\s+(?:möchtest|möchten|brauchst|brauchen))/i,
  },
]

const ENGLISH_ASSISTANT_OFFER =
  /\b(?:i\s+(?:can|could|will|(?:'|’)ll)|i(?:'|’)m\s+happy\s+to|let\s+me\s+know\s+if\s+you\s+(?:want|would\s+like|need)\s+me\s+to)\b/i

/**
 * Removes empty optional follow-up filler from the tail of a GPT/OpenAI-family
 * user-visible reply.
 *
 * GPT-only instruction/guard metadata: this is a provider-scoped cleanup for
 * GPT/OpenAI-family models (`openai`, `openai-codex`) that tend to append empty
 * "if you want, I can also ..." offers. Non-GPT providers must leave this guard
 * disabled so their channel text is not rewritten by GPT-specific heuristics.
 *
 * The guard is intentionally tail-only and CTA-shaped: it strips standalone
 * sentences/paragraphs such as "If you want, I can also ...", "원하면 ...",
 * "必要でしたら ...", and "如果需要 ...". It does not remove ordinary
 * conditionals in substantive content, especially non-tail sentences like
 * "If the webhook is disabled, restart is required."
 */
export function stripEmptyOptionalFollowupFiller(text: string, enabled = true): string {
  if (!enabled) return text
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
    if (ch === '。' || ch === '！' || ch === '？') return i
    if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(text[i + 1] ?? '')) return i
  }
  return -1
}

function isEmptyOptionalFollowup(sentence: string): boolean {
  const normalized = sentence.trim()
  if (normalized.length === 0) return false
  for (const pattern of OPTIONAL_FOLLOWUP_PATTERNS) {
    if (!pattern.start.test(normalized)) continue
    if (pattern.requiresAssistantOffer === true && !hasEnglishAssistantOffer(normalized)) continue
    return true
  }
  return false
}

function hasEnglishAssistantOffer(text: string): boolean {
  return ENGLISH_ASSISTANT_OFFER.test(text)
}
