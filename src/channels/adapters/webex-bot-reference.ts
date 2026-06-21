import type { WebexBotClient } from 'agent-messenger/webexbot'

import type { InboundMessage, QuoteAnchorSource } from '@/channels/types'

import { resolveWebexBodyText } from './webex-format'

// Webex Mercury delivers only the parent message id inline, not its author,
// so the classifier cannot tell whether a reply targets the bot. We fetch the
// parent here (already needed for the quote anchor) and use its author to set
// the reply-target fields the engagement layer reads: a non-mention reply to a
// bot-authored parent must engage via the `reply` trigger, and a reply to a
// different author must suppress the solo-human fallback. Both are no-ops if
// the classifier already attributed the reply (it sets replyToBotMessageId
// when the reply also @-mentions the bot).
export async function enrichWebexMessageReference(args: {
  client: Pick<WebexBotClient, 'getMessage'>
  inbound: InboundMessage
  parentRef?: string
  botPersonId: string | null
}): Promise<InboundMessage> {
  if (args.parentRef === undefined || args.parentRef === '') return args.inbound
  try {
    const parent = await args.client.getMessage(args.parentRef)
    const attributed = attributeReply(args.inbound, parent.ref, parent.personRef, args.botPersonId)
    const source: QuoteAnchorSource = {
      adapter: 'webex-bot',
      authorId: parent.personRef,
      authorName: parent.personEmail,
      text: resolveWebexBodyText(parent),
    }
    if (source.text.trim() === '') return attributed
    return { ...attributed, referenceContext: { kind: 'reply', sources: [source] } }
  } catch {
    return args.inbound
  }
}

function attributeReply(
  inbound: InboundMessage,
  parentId: string,
  parentPersonId: string,
  botPersonId: string | null,
): InboundMessage {
  if (inbound.replyToBotMessageId !== null || inbound.replyToOtherMessageId !== null) return inbound
  if (botPersonId !== null && parentPersonId === botPersonId) {
    return { ...inbound, replyToBotMessageId: parentId }
  }
  return { ...inbound, replyToOtherMessageId: parentId }
}
