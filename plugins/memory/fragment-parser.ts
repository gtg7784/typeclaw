import { createHash } from 'node:crypto'

export type Fragment = {
  readonly source: string
  readonly entry: string
  readonly topic: string
  readonly body: string
}

const FRAGMENT_HEADER = /<!--\s*fragment\s+source=(\S+)\s+entry=(\S+)(?:\s+\S+=\S+)*\s*-->/g

export function parseFragments(content: string): Fragment[] {
  const fragments: Fragment[] = []
  const headers: { source: string; entry: string; index: number; endIndex: number }[] = []
  for (const match of content.matchAll(FRAGMENT_HEADER)) {
    if (match.index === undefined) continue
    headers.push({
      source: match[1]!,
      entry: match[2]!,
      index: match.index,
      endIndex: match.index + match[0].length,
    })
  }

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!
    const nextStart = headers[i + 1]?.index ?? content.length
    const between = content.slice(header.endIndex, nextStart)
    const parsed = parseTopicAndBody(between)
    if (parsed === null) continue
    fragments.push({ source: header.source, entry: header.entry, topic: parsed.topic, body: parsed.body })
  }
  return fragments
}

export function fragmentContentHash(fragment: Pick<Fragment, 'topic' | 'body'>): string {
  const normalized = `${normalize(fragment.topic)}\n\n${normalize(fragment.body)}`
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

function parseTopicAndBody(between: string): { topic: string; body: string } | null {
  const lines = between.split('\n')
  let i = 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  if (i >= lines.length) return null
  const topicLine = lines[i]!
  const topicMatch = topicLine.match(/^##\s+(.+?)\s*$/)
  if (topicMatch === null) return null
  const topic = topicMatch[1]!

  const bodyLines: string[] = []
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]!
    if (/<!--\s*(?:fragment|watermark)\s/.test(line)) break
    bodyLines.push(line)
  }
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === '') bodyLines.pop()
  return { topic, body: bodyLines.join('\n') }
}

function normalize(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}
