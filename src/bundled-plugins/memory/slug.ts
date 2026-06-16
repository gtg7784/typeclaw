import { createHash } from 'node:crypto'

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug)
}

export function headingToSlug(heading: string, existingSlugs: Set<string>): string {
  let slug = normalizeHeading(heading)

  if (slug.length === 0) {
    slug = makeUntitledSlug(heading)
  }

  slug = slug.slice(0, 64)

  slug = deduplicateSlug(slug, existingSlugs)

  return slug
}

// True only when `slug` is a clean kebab echo of `heading` (the readable form
// adds nothing the slug doesn't). `headingToSlug` maps every non-ASCII letter,
// ideograph, or symbol to `-` (or to an `untitled-<hash>` when nothing survives),
// so a heading like `한글 memo` slugifies to `memo` and an all-CJK/emoji heading to
// the fallback — collapsing either would drop the only human-readable name. Guard
// by requiring the diacritic-folded heading to consist solely of ASCII
// alphanumerics and separators/punctuation; any surviving CJK/emoji/symbol means
// normalization discarded content, so it is never an echo. (Diacritics are
// transliterated, not dropped — `café` → `cafe` stays a legitimate echo.)
const ECHO_SAFE_HEADING = /^[A-Za-z0-9\s\p{P}]*$/u

export function slugIsHeadingEcho(heading: string, slug: string): boolean {
  const folded = heading.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (!ECHO_SAFE_HEADING.test(folded)) {
    return false
  }
  return headingToSlug(heading, new Set<string>()) === slug
}

function normalizeHeading(heading: string): string {
  let normalized = heading.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  normalized = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized
}

function makeUntitledSlug(heading: string): string {
  const hash = createHash('sha256').update(heading).digest('hex').slice(0, 6)
  return `untitled-${hash}`
}

function deduplicateSlug(slug: string, existingSlugs: Set<string>): string {
  const lowerSlug = slug.toLowerCase()
  let candidate = lowerSlug
  let suffix = 2

  while (isTaken(candidate, existingSlugs)) {
    candidate = `${lowerSlug}-${suffix}`
    suffix++
  }

  return candidate
}

function isTaken(candidate: string, existingSlugs: Set<string>): boolean {
  for (const existing of existingSlugs) {
    if (existing.toLowerCase() === candidate) {
      return true
    }
  }
  return false
}
