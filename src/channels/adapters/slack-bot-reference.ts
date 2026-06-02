import type { InboundReferenceContext, QuoteAnchorSource } from '@/channels/types'

export type SlackResolvedReference = {
  authorId: string
  authorName: string
  text: string
}

export type SlackReferenceFetch = (channelId: string, messageTs: string) => Promise<SlackResolvedReference | null>

export type SlackMessagePointer = {
  channelId: string
  messageTs: string
}

export async function enrichSlackReferenceContext(args: {
  text: string
  channelId: string
  threadTs?: string
  messageTs: string
  attachments?: readonly unknown[]
  fetchMessage: SlackReferenceFetch
  linkLimit?: number
}): Promise<{ text: string; referenceContext?: InboundReferenceContext }> {
  const sources: QuoteAnchorSource[] = []
  let kind: InboundReferenceContext['kind'] = 'link'

  if (args.threadTs !== undefined && args.threadTs !== args.messageTs) {
    const parent = await fetchSafely(args.fetchMessage, { channelId: args.channelId, messageTs: args.threadTs })
    if (parent !== null) {
      sources.push(toSource(parent))
      kind = 'reply'
    }
  }

  for (const source of extractSlackShareSources(args.attachments ?? [])) {
    sources.push(source)
    if (kind !== 'reply') kind = 'quote'
  }

  const links = extractSlackMessageLinks(args.text).slice(0, args.linkLimit ?? 3)
  const seen = new Set(sources.map((source) => `${source.authorId}\x00${source.text}`))
  for (const link of links) {
    const message = await fetchSafely(args.fetchMessage, link)
    if (message === null) continue
    const source = toSource(message)
    const key = `${source.authorId}\x00${source.text}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(source)
  }

  if (sources.length === 0) return { text: args.text }
  return { text: args.text, referenceContext: { kind, sources } }
}

export function hasSlackMessageShareAttachments(attachments: readonly unknown[] | undefined): boolean {
  return extractSlackShareSources(attachments ?? []).length > 0
}

const SLACK_ARCHIVE_LINK = /https?:\/\/[^\s/]+\.slack\.com\/archives\/([^/\s]+)\/p(\d{10})(\d{6})/g

function extractSlackMessageLinks(text: string): SlackMessagePointer[] {
  const seen = new Set<string>()
  const links: SlackMessagePointer[] = []
  for (const match of text.matchAll(SLACK_ARCHIVE_LINK)) {
    const channelId = match[1]
    const seconds = match[2]
    const micros = match[3]
    if (channelId === undefined || seconds === undefined || micros === undefined) continue
    const messageTs = `${seconds}.${micros}`
    const key = `${channelId}:${messageTs}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ channelId, messageTs })
  }
  return links
}

// A stable author id is required because the quote renders as `<@id>`
// downstream; a name-only source would emit `<@unknown>`, worse than omitting
// the context. Forwarded message-shares put it under `author_id`, classic
// shares under `user`/`user_id`. `author_subname` is Slack's display-name
// fallback on forwarded messages — used for the name only, never the id.
function extractSlackShareSources(attachments: readonly unknown[]): QuoteAnchorSource[] {
  const sources: QuoteAnchorSource[] = []
  for (const attachment of attachments) {
    const record = recordValue(attachment)
    if (record === null) continue
    const text = stringField(record, 'text') ?? stringField(record, 'fallback')
    if (text === null || text.trim() === '') continue
    const authorId = stringField(record, 'author_id') ?? stringField(record, 'user') ?? stringField(record, 'user_id')
    if (authorId === null) continue
    const authorName = stringField(record, 'author_name') ?? stringField(record, 'author_subname') ?? authorId
    sources.push({
      adapter: 'slack-bot',
      authorId,
      authorName,
      text,
    })
  }
  return sources
}

async function fetchSafely(
  fetchMessage: SlackReferenceFetch,
  pointer: SlackMessagePointer,
): Promise<SlackResolvedReference | null> {
  try {
    return await fetchMessage(pointer.channelId, pointer.messageTs)
  } catch {
    return null
  }
}

function toSource(message: SlackResolvedReference): QuoteAnchorSource {
  return { adapter: 'slack-bot', authorId: message.authorId, authorName: message.authorName, text: message.text }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
