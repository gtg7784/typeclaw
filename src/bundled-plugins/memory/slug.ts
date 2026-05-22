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
