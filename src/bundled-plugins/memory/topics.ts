// Topic-aware parser for MEMORY.md. The dreaming subagent writes MEMORY.md as
// a flat list of level-2 topic headings (`## <topic>`), each followed by a
// conclusion paragraph and a `fragments:` bullet list of citations. The
// citation parser in citations.ts is global (every citation in the file);
// this module attributes citations to their owning topic so the dreaming
// subagent can see per-topic strength signals (citation count, distinct
// reinforcement days, recency) on its next run.
//
// Format assumptions match what dreaming.ts's DREAMING_SYSTEM_PROMPT teaches:
//   - First line is `# Memory` (an h1). Treated as a non-topic header.
//   - Topics are h2s (`## <topic>`). Anything below an h2 and above the next
//     h2 (or EOF) belongs to that topic.
//   - Citations in a topic's body — wherever they appear, bullet-list or
//     inline prose — count toward that topic's strength.
//   - Content above the first h2 (e.g. preamble after `# Memory`) is
//     attributed to no topic and its citations are dropped from the per-topic
//     aggregation. parseCitations from citations.ts still picks them up if
//     anything downstream needs the global view.
//
// The parser is intentionally permissive: it never throws on malformed
// MEMORY.md. A subagent that writes a header with no body or a topic with no
// citations still parses cleanly with an empty `citations` array. The
// strength layer then treats those topics as "weak" — which is the right
// behavior, since they ARE weak.

import { type Citation, parseCitations } from './citations'

export type Topic = {
  // The heading text after `## ` with surrounding whitespace trimmed. Empty
  // string is allowed (`## ` with no title) so a malformed write still
  // round-trips through the parser; the strength layer surfaces empty
  // headings as themselves so the subagent can clean them up.
  heading: string
  // Citations attached to this topic, deduplicated per `(date, fragmentId)`.
  // The dedupe happens inside parseCitations (which returns a Set of ids per
  // date), so a fragment cited twice in one topic — once in inline prose,
  // once in the fragments: block — counts only once toward strength signals.
  // Order is by date insertion in parseCitations, not by appearance in the
  // topic body; consumers that need appearance order should re-parse.
  citations: Citation[]
}

const HEADING_LEVEL_2 = /^##\s+(.*)$/

// Split MEMORY.md into ordered topics with their citations attached. Returns
// an empty array when no `## ` heading appears.
export function parseTopics(text: string): Topic[] {
  const lines = text.split('\n')
  const topics: Topic[] = []
  let current: { heading: string; body: string[] } | undefined

  const flush = (): void => {
    if (!current) return
    const bodyText = current.body.join('\n')
    const grouped = parseCitations(bodyText)
    const citations: Citation[] = []
    for (const [date, ids] of grouped) {
      for (const fragmentId of ids) citations.push({ date, fragmentId })
    }
    topics.push({ heading: current.heading, citations })
  }

  for (const line of lines) {
    const match = HEADING_LEVEL_2.exec(line)
    if (match) {
      flush()
      current = { heading: (match[1] ?? '').trim(), body: [] }
      continue
    }
    if (current) current.body.push(line)
  }
  flush()

  return topics
}
