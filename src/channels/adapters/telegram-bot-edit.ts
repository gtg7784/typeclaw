import type { TelegramBotClient } from 'agent-messenger/telegrambot'

import type { EditMessageCallback, EditMessageResult } from '@/channels/types'

import { toTelegramMarkdownV2 } from './telegram-bot-format'

export function createTelegramEditMessageCallback(deps: {
  client: Pick<TelegramBotClient, 'editMessageText'>
}): EditMessageCallback {
  return async (req): Promise<EditMessageResult> => {
    if (req.adapter !== 'telegram-bot') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'not-supported' }
    }
    // A telegram message id is numeric; the router carries it as the string the
    // send handed back (String(message_id)). A non-numeric value can't address
    // any message, so it's a not-found miss rather than an API round-trip.
    const messageId = Number(req.messageId)
    if (!Number.isInteger(messageId)) {
      return { ok: false, error: `non-numeric telegram message id: ${req.messageId}`, code: 'not-found' }
    }
    try {
      // Render + escape through the SAME MarkdownV2 pipeline the send path uses,
      // and pass the same parse_mode — otherwise an edit would show literal
      // markdown where the original send rendered it (or fail on unescaped
      // reserved chars). Keeps a sent message and its later edit visually identical.
      const rendered = toTelegramMarkdownV2(req.text)
      await deps.client.editMessageText({ chat_id: req.chat, message_id: messageId }, rendered, {
        parse_mode: 'MarkdownV2',
      })
    } catch (err) {
      // "message is not modified" fires when the new text equals the current
      // body — the desired end state already holds, so treat it as success
      // (idempotent), mirroring the reaction adapters' already-in-state handling.
      if (describe(err).toLowerCase().includes('message is not modified')) return { ok: true }
      return { ok: false, error: describe(err), code: classifyEditError(err) }
    }
    return { ok: true }
  }
}

// "message to edit not found" / "message can't be edited" (too old) map to
// not-found; a chat-permission error to permission-denied.
function classifyEditError(err: unknown): NonNullable<(EditMessageResult & { ok: false })['code']> {
  const message = describe(err).toLowerCase()
  if (message.includes('not enough rights') || message.includes('forbidden')) return 'permission-denied'
  return 'not-found'
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
