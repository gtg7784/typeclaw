export type GrepOptions = {
  pattern: string
  before?: number
  after?: number
  limit?: number
  offset?: number
}

export class GrepError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrepError'
  }
}

export function applyGrep(content: string, options: GrepOptions): string {
  const before = Math.max(0, options.before ?? 0)
  const after = Math.max(0, options.after ?? 0)
  const limit = Math.max(1, options.limit ?? 100)
  const offset = Math.max(0, options.offset ?? 0)

  const matcher = compile(options.pattern)
  const lines = content.split('\n')

  const matchingIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (matcher.test(lines[i] ?? '')) matchingIndices.push(i)
  }

  if (matchingIndices.length === 0) {
    return `No matches for pattern: ${options.pattern}`
  }

  const contextIndices = new Set<number>()
  for (const idx of matchingIndices) {
    const start = Math.max(0, idx - before)
    const end = Math.min(lines.length - 1, idx + after)
    for (let i = start; i <= end; i++) contextIndices.add(i)
  }
  const sorted = Array.from(contextIndices).sort((a, b) => a - b)
  const page = sorted.slice(offset, offset + limit)

  const matching = new Set(matchingIndices)
  const out: string[] = []
  let prev = -2
  for (const idx of page) {
    if (prev !== -2 && idx > prev + 1) out.push('--')
    prev = idx
    const sep = matching.has(idx) ? ':' : '-'
    out.push(`${idx + 1}${sep}${lines[idx] ?? ''}`)
  }

  const totalMatches = matchingIndices.length
  const shown = page.length
  const totalContext = sorted.length
  const header = `Found ${totalMatches} matching line(s); showing ${shown} of ${totalContext} context line(s).`
  return `${header}\n${out.join('\n')}`
}

// Always build a fresh, non-global RegExp. The `g` flag carries `lastIndex`
// state across `.test()` calls, which silently skips matches when reused in a
// loop (oh-my-openagent PR #195 hit this exact bug).
function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new GrepError(`Invalid regex pattern: ${message}`)
  }
}
