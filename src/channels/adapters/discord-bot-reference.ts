export type DiscordResolvedReference = {
  authorName: string
  text: string
}

export type DiscordReferenceFetch = (channelId: string, messageId: string) => Promise<DiscordResolvedReference | null>

export type DiscordMessagePointer = {
  channelId: string
  messageId: string
}

export async function enrichDiscordMessageReferences(args: {
  text: string
  reply?: DiscordMessagePointer
  fetchMessage: DiscordReferenceFetch
  linkLimit?: number
  textLimit?: number
}): Promise<string> {
  const textLimit = args.textLimit ?? 280
  const parts: string[] = []

  if (args.reply !== undefined) {
    const parent = await fetchSafely(args.fetchMessage, args.reply)
    if (parent !== null) parts.push(renderReply(parent, textLimit))
  }

  parts.push(args.text)

  const links = extractDiscordMessageLinks(args.text).slice(0, args.linkLimit ?? 3)
  const linkBlocks: string[] = []
  for (const link of links) {
    const message = await fetchSafely(args.fetchMessage, link)
    if (message !== null) linkBlocks.push(renderLink(message, textLimit))
  }

  if (linkBlocks.length > 0) parts.push(linkBlocks.join('\n'))

  return parts.join('\n\n').replace(/^(.+)\n\n(.*)$/s, (all, first: string, rest: string) => {
    if (!first.startsWith('> ↩ Reply to ')) return all
    return `${first}\n${rest}`
  })
}

const DISCORD_MESSAGE_LINK = /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/g

function extractDiscordMessageLinks(text: string): DiscordMessagePointer[] {
  const seen = new Set<string>()
  const links: DiscordMessagePointer[] = []
  for (const match of text.matchAll(DISCORD_MESSAGE_LINK)) {
    const channelId = match[2]
    const messageId = match[3]
    if (channelId === undefined || messageId === undefined) continue
    const key = `${channelId}:${messageId}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ channelId, messageId })
  }
  return links
}

async function fetchSafely(
  fetchMessage: DiscordReferenceFetch,
  pointer: DiscordMessagePointer,
): Promise<DiscordResolvedReference | null> {
  try {
    return await fetchMessage(pointer.channelId, pointer.messageId)
  } catch {
    return null
  }
}

function renderReply(message: DiscordResolvedReference, textLimit: number): string {
  return `> ↩ Reply to ${singleLine(message.authorName)}: ${truncate(singleLine(message.text), textLimit)}`
}

function renderLink(message: DiscordResolvedReference, textLimit: number): string {
  return `> 🔗 Discord message from ${singleLine(message.authorName)}: ${truncate(singleLine(message.text), textLimit)}`
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}
