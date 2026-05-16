import { createHash } from 'node:crypto'

import { parseEventLine } from './stream-events'

export type Fragment = {
  source: string
  entry: string
  topic: string
  body: string
}

export function parseFragments(content: string): Fragment[] {
  const fragments: Fragment[] = []
  const lines = content.split('\n')
  for (const line of lines) {
    if (line.trim() === '') continue
    const event = parseEventLine(line)
    if (event === null) continue
    if (event.type === 'fragment') {
      fragments.push({
        source: event.source,
        entry: event.entry,
        topic: event.topic,
        body: event.body,
      })
    }
  }
  return fragments
}

export function fragmentContentHash(fragment: Pick<Fragment, 'topic' | 'body'>): string {
  const normalized = `${normalize(fragment.topic)}\n\n${normalize(fragment.body)}`
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

function normalize(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}
