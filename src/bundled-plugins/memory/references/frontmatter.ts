export type ReferenceOrigin = 'episode' | 'curated' | 'external'

export type ReferenceFrontmatter = {
  title: string
  origin: ReferenceOrigin
  created: string
  lastAccessed: string
  accessCount: number
  pinned: boolean
  demoted: boolean
  tags: string[]
}

const ORIGINS = new Set<ReferenceOrigin>(['episode', 'curated', 'external'])
const ISO_WITH_TIMEZONE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function parseReference(text: string): { frontmatter: ReferenceFrontmatter; body: string } {
  const normalized = text.replaceAll('\r\n', '\n')

  if (!normalized.startsWith('---\n')) {
    throw new Error('frontmatter delimiter missing')
  }

  const closeIndex = normalized.indexOf('\n---', 4)
  if (closeIndex === -1) {
    throw new Error('frontmatter delimiter missing')
  }

  const fmText = normalized.slice(4, closeIndex)
  const body = normalized.slice(closeIndex + 5)

  const frontmatter = parseFrontmatterBlock(fmText)
  return { frontmatter, body }
}

export function renderReference(frontmatter: ReferenceFrontmatter, body: string): string {
  const lines = ['---']
  lines.push(`title: ${frontmatter.title}`)
  lines.push(`origin: ${frontmatter.origin}`)
  lines.push(`created: ${frontmatter.created}`)
  lines.push(`lastAccessed: ${frontmatter.lastAccessed}`)
  lines.push(`accessCount: ${frontmatter.accessCount}`)
  lines.push(`pinned: ${frontmatter.pinned}`)
  lines.push(`demoted: ${frontmatter.demoted}`)
  if (frontmatter.tags.length === 0) {
    lines.push('tags: []')
  } else {
    lines.push(`tags: [${frontmatter.tags.join(', ')}]`)
  }
  lines.push('---')
  lines.push(body)
  return lines.join('\n')
}

function parseFrontmatterBlock(text: string): ReferenceFrontmatter {
  const lines = text.split('\n')
  const values: Record<string, unknown> = {}

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      i++
      continue
    }

    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) {
      i++
      continue
    }

    const key = line.slice(0, colonIndex).trim()
    const rest = line.slice(colonIndex + 1).trim()

    if (key === 'tags') {
      if (rest === '') {
        const listItems: string[] = []
        i++
        while (i < lines.length) {
          const listLine = lines[i]!
          if (!listLine.startsWith('  - ')) break
          listItems.push(listLine.slice(4).trim())
          i++
        }
        values.tags = listItems
        continue
      }
      if (rest.startsWith('[') && rest.endsWith(']')) {
        values.tags = rest
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        i++
        continue
      }
      throw new Error(`frontmatter field 'tags': expected array, got '${rest}'`)
    }

    if (key in FRONTMATTER_PARSERS) {
      try {
        values[key] = FRONTMATTER_PARSERS[key as keyof typeof FRONTMATTER_PARSERS](rest)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`frontmatter field '${key}': ${message}`)
      }
    } else {
      throw new Error(`frontmatter field '${key}': unknown`)
    }

    i++
  }

  return buildReferenceFrontmatter(values)
}

const FRONTMATTER_PARSERS = {
  title: (v: string) => v,
  origin: parseOrigin,
  created: parseIsoWithTimezone,
  lastAccessed: parseIsoWithTimezone,
  accessCount: parseNonNegativeInt,
  pinned: parseBoolean,
  demoted: parseBoolean,
}

function buildReferenceFrontmatter(values: Record<string, unknown>): ReferenceFrontmatter {
  const title = values.title
  if (typeof title !== 'string' || title.length === 0) {
    throw new Error("frontmatter field 'title': required")
  }

  const origin = values.origin
  if (!isReferenceOrigin(origin)) {
    throw new Error(`frontmatter field 'origin': expected episode | curated | external, got '${values.origin}'`)
  }

  const created = values.created
  if (typeof created !== 'string') {
    throw new Error(`frontmatter field 'created': expected ISO 8601 datetime with timezone, got '${values.created}'`)
  }

  const pinned = values.pinned
  if (typeof pinned !== 'boolean') {
    throw new Error(`frontmatter field 'pinned': expected boolean, got '${values.pinned}'`)
  }

  const tags = values.tags
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
    throw new Error(`frontmatter field 'tags': expected array, got '${values.tags}'`)
  }

  return {
    title,
    origin,
    created,
    lastAccessed: typeof values.lastAccessed === 'string' ? values.lastAccessed : created,
    accessCount: typeof values.accessCount === 'number' ? values.accessCount : 0,
    pinned,
    demoted: typeof values.demoted === 'boolean' ? values.demoted : false,
    tags,
  }
}

function parseOrigin(value: string): ReferenceOrigin {
  if (!isReferenceOrigin(value)) {
    throw new Error(`expected episode | curated | external, got '${value}'`)
  }
  return value
}

function parseIsoWithTimezone(value: string): string {
  if (!ISO_WITH_TIMEZONE_REGEX.test(value)) {
    throw new Error(`expected ISO 8601 datetime with timezone, got '${value}'`)
  }
  return value
}

function parseNonNegativeInt(value: string): number {
  const trimmed = value.trim()
  const num = Number(trimmed)
  if (!Number.isInteger(num) || String(num) !== trimmed || num < 0) {
    throw new Error(`expected non-negative integer, got '${value}'`)
  }
  return num
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`expected boolean, got '${value}'`)
}

function isReferenceOrigin(value: unknown): value is ReferenceOrigin {
  return typeof value === 'string' && ORIGINS.has(value as ReferenceOrigin)
}
