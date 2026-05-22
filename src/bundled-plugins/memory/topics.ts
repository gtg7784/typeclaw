// Topic-aware parser for the pre-shard root-memory migration and legacy strength
// tests. Sharded runtime memory stores each topic as its own file under
// memory/topics/, but the one-shot migrator still needs to split a legacy root
// file into level-2 topic sections before writing shards.
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
// The parser is intentionally permissive: it never throws on malformed legacy
// topic prose. A header with no body or a topic with no citations still parses
// cleanly with an empty `citations` array. The
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

export type TopicWithBody = Topic & { body: string }

const HEADING_LEVEL_2 = /^##\s+(.*)$/
const HISTORICAL_BUCKET = /^historical observations$/i
const BULLET_LINE = /^-\s+(.*)$/
const LEADING_DATE = /^\d{4}-\d{2}-\d{2}:\s*/
const CITATION_TAIL = /\s*—\s+memory\/.*$/

function collectCitations(bodyText: string): Citation[] {
  const grouped = parseCitations(bodyText)
  const citations: Citation[] = []
  for (const [date, ids] of grouped) {
    for (const fragmentId of ids) citations.push({ date, fragmentId })
  }
  return citations
}

// Split legacy topic prose into ordered topics with their citations attached. Returns
// an empty array when no `## ` heading appears.
export function parseTopics(text: string): Topic[] {
  const lines = text.split('\n')
  const topics: Topic[] = []
  let current: { heading: string; body: string[] } | undefined

  const flush = (): void => {
    if (!current) return
    const citations = collectCitations(current.body.join('\n'))
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

// Like parseTopics, but preserves the full body text of each topic. The
// `## Historical observations` bucket is expanded into one entry per bullet.
export function parseTopicsWithBodies(text: string): TopicWithBody[] {
  const lines = text.split('\n')
  const topics: TopicWithBody[] = []
  let current: { heading: string; body: string[] } | undefined

  const flush = (): void => {
    if (!current) return
    const bodyText = current.body.join('\n')
    if (HISTORICAL_BUCKET.test(current.heading)) {
      let index = 0
      for (const line of current.body) {
        const bulletMatch = BULLET_LINE.exec(line)
        if (!bulletMatch) continue
        const bulletText = bulletMatch[1] ?? ''
        let heading = bulletText.replace(LEADING_DATE, '').replace(CITATION_TAIL, '').trim()
        const citations = collectCitations(bulletText)
        if (!heading) {
          heading = citations[0]?.date ?? `historical-${index}`
        }
        topics.push({ heading, body: bulletText, citations })
        index++
      }
      return
    }
    topics.push({
      heading: current.heading,
      body: bodyText,
      citations: collectCitations(bodyText),
    })
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
