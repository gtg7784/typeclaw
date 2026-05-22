export type ShardFrontmatter = {
  heading: string
  cites: number
  days: number
  lastReinforced: string
  tags?: string[]
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

export function parseShard(text: string): { frontmatter: ShardFrontmatter; body: string } {
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

function parseFrontmatterBlock(text: string): ShardFrontmatter {
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
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        values.tags = rest
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        i++
        continue
      } else if (rest === '[]') {
        values.tags = []
        i++
        continue
      } else {
        throw new Error(`frontmatter field 'tags': expected array, got '${rest}'`)
      }
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

  const heading = values.heading
  if (typeof heading !== 'string' || heading.length === 0) {
    throw new Error("frontmatter field 'heading': required")
  }

  const cites = values.cites
  if (typeof cites !== 'number') {
    throw new Error(`frontmatter field 'cites': expected integer, got '${values.cites}'`)
  }

  const days = values.days
  if (typeof days !== 'number') {
    throw new Error(`frontmatter field 'days': expected integer, got '${values.days}'`)
  }

  const lastReinforced = values.lastReinforced
  if (typeof lastReinforced !== 'string' || !DATE_REGEX.test(lastReinforced)) {
    throw new Error(`frontmatter field 'lastReinforced': expected YYYY-MM-DD, got '${values.lastReinforced}'`)
  }

  const result: ShardFrontmatter = { heading, cites, days, lastReinforced }
  if ('tags' in values) {
    result.tags = values.tags as string[]
  }

  return result
}

const FRONTMATTER_PARSERS: {
  [K in keyof Omit<ShardFrontmatter, 'tags'>]: (value: string) => unknown
} = {
  heading: (v) => v,
  cites: parseNonNegativeInt,
  days: parseNonNegativeInt,
  lastReinforced: (v) => v,
}

function parseNonNegativeInt(value: string): number {
  const trimmed = value.trim()
  const num = Number(trimmed)
  if (!Number.isInteger(num) || String(num) !== trimmed || num < 0) {
    throw new Error(`expected non-negative integer, got '${value}'`)
  }
  return num
}

export function renderShard(frontmatter: ShardFrontmatter, body: string): string {
  const lines = ['---']
  lines.push(`heading: ${frontmatter.heading}`)
  lines.push(`cites: ${frontmatter.cites}`)
  lines.push(`days: ${frontmatter.days}`)
  lines.push(`lastReinforced: ${frontmatter.lastReinforced}`)
  if (frontmatter.tags !== undefined) {
    if (frontmatter.tags.length === 0) {
      lines.push('tags: []')
    } else {
      lines.push(`tags: [${frontmatter.tags.join(', ')}]`)
    }
  }
  lines.push('---')
  lines.push(body)
  return lines.join('\n')
}

export function updateFrontmatter(text: string, patch: Partial<ShardFrontmatter>): string {
  const { frontmatter, body } = parseShard(text)
  const updated: ShardFrontmatter = { ...frontmatter, ...patch }
  if ('tags' in patch && patch.tags === undefined) {
    delete (updated as Record<string, unknown>).tags
  }
  return renderShard(updated, body)
}
