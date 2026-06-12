// Citation format: `streams/yyyy-MM-dd#<fragment-id>`. The id is the full
// UUIDv7 of the fragment event in the daily JSONL stream. The date prefix is
// redundant with the id's timestamp (UUIDv7 encodes minting time in the first
// 48 bits) but kept for human grep-ability — readers should be able to see
// "this came from yesterday's stream" without parsing the id.
//
// The format does NOT accept line ranges. The prior `:43-45` shape is gone
// (see the "drop backward compat" decision in the PR description). Parsing
// silently ignores any line in a topic shard that doesn't match this exact shape,
// so legacy citations from before the cutover are dropped — they no longer
// pin fragments alive against compaction.

export const CITATION_FORMAT_CANONICAL = 'streams' as const
export const acceptedPrefixes = ['streams', 'memory'] as const

// Single alternation keeps line and global parsing on the same transitional
// prefix set while dropping the prefix from the public Citation shape.
const CITATION_LINE = /^[\s-]*(streams|memory)\/(\d{4}-\d{2}-\d{2})#([\w-]+)\s*$/im

const CITATION_LINE_GLOBAL = /(streams|memory)\/(\d{4}-\d{2}-\d{2})#([\w-]+)/g

const LEGACY_CITATION_GLOBAL = /memory\/(\d{4}-\d{2}-\d{2})#([\w-]+)/g

export type Citation = { date: string; fragmentId: string }

export function formatCitation(date: string, fragmentId: string): string {
  return `${CITATION_FORMAT_CANONICAL}/${date}#${fragmentId}`
}

export function normalizeCitation(citation: string): string {
  return citation.replace(LEGACY_CITATION_GLOBAL, `${CITATION_FORMAT_CANONICAL}/$1#$2`)
}

// Parse every citation in `text` and return them grouped by date. The
// returned Map is empty when no citations appear. Used by:
//   - dreaming.ts compaction to decide which fragments are still referenced
//     by topic shards and must survive GC.
//   - tests pinning the format.
export function parseCitations(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const match of text.matchAll(CITATION_LINE_GLOBAL)) {
    const date = match[2]!
    const fragmentId = match[3]!
    let set = out.get(date)
    if (set === undefined) {
      set = new Set<string>()
      out.set(date, set)
    }
    set.add(fragmentId)
  }
  return out
}

export function isCitationLine(line: string): boolean {
  return CITATION_LINE.test(line)
}

// Superseded citations stay cited (so the citation-superset GC invariant never
// drops them) but must be excluded from retrieval, so a superseded "uses bun"
// fragment can't surface as a hook for the current "uses pnpm" belief.
// `parseCitations` stays section-blind for GC; this is the status-aware view.
// Citations before any heading count as active (legacy shards had no section).
const SECTION_HEADING = /^[\s-]*(fragments|superseded)\s*:\s*$/i

export type SectionedCitations = { active: Set<string>; superseded: Set<string> }

export function splitCitationsBySection(body: string): SectionedCitations {
  const active = new Set<string>()
  const superseded = new Set<string>()
  let current: 'active' | 'superseded' = 'active'

  for (const line of body.split('\n')) {
    const heading = SECTION_HEADING.exec(line)
    if (heading !== null) {
      current = heading[1]!.toLowerCase() === 'superseded' ? 'superseded' : 'active'
      continue
    }
    const citation = CITATION_LINE.exec(line)
    if (citation === null) continue
    ;(current === 'superseded' ? superseded : active).add(citation[3]!)
  }

  // Re-affirmed fact (appears in both sections across edits): active wins.
  for (const id of active) superseded.delete(id)

  return { active, superseded }
}
