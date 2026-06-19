import type { WebexBotClient } from 'agent-messenger/webexbot'

import type { InboundMessage, QuoteAnchorSource } from '@/channels/types'

export async function enrichWebexMessageReference(args: {
  client: Pick<WebexBotClient, 'getMessage'>
  inbound: InboundMessage
  parentId?: string
}): Promise<InboundMessage> {
  if (args.parentId === undefined || args.parentId === '') return args.inbound
  try {
    const parent = await args.client.getMessage(args.parentId)
    const source: QuoteAnchorSource = {
      adapter: 'webex-bot',
      authorId: parent.personId,
      authorName: parent.personEmail,
      text: parent.text ?? parent.markdown ?? parent.html ?? '',
    }
    if (source.text.trim() === '') return args.inbound
    return { ...args.inbound, referenceContext: { kind: 'reply', sources: [source] } }
  } catch {
    return args.inbound
  }
}
