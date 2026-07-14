import type { KakaoTypingResult } from 'agent-messenger/kakaotalk'

import type { TypingCallback } from '@/channels/types'

import { describeError } from './describe-error'

export type KakaoTypingLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

// Emits the LOCO ACTION packet directly from the sub-device session via
// `KakaoTalkClient.sendTyping` (agent-messenger#302). `type=1` is the value the
// official app uses for the animated "…" composing indicator; the SDK omits
// `linkId` unless it's an OpenChat room.
export type KakaoTypingSender = (chatId: string, opts?: { linkId?: string }) => Promise<KakaoTypingResult>

// KakaoTalk auto-expires the composing indicator ~5s after the last ACTION
// packet. The router paces the refresh via a 5s heartbeat registered by the
// adapter (setTypingHeartbeatInterval), so this callback stays stateless: each
// tick sends one packet, and there is no stop API — a delivered message clears
// the indicator client-side, so 'stop' is a no-op (mirrors telegram-bot).
export const KAKAO_TYPING_HEARTBEAT_MS = 5000

// OpenChat ACTION packets require the LOCO `linkId` field, which the channel
// resolver does not surface today (the same limitation `markReadIfSupported`
// documents for NOTIREAD). Rather than emit a doomed pulse, we skip typing for
// `@kakao-open` and log once per chat. Wiring linkId through the resolver is a
// follow-up shared with mark-read.
const OPEN_CHAT_WORKSPACE = '@kakao-open'

export function createKakaoTypingCallback(deps: {
  logger: KakaoTypingLogger
  sendTyping: KakaoTypingSender
  formatChannelTag?: (workspace: string, chat: string) => Promise<string>
}): TypingCallback {
  const { logger, sendTyping, formatChannelTag } = deps
  // Per-chat FIFO mirrors the webex/slack pattern: chaining each request through
  // the per-chat tail keeps on-the-wire order matching enqueue order even under
  // network jitter, so a slow send can't reorder behind a later tick.
  const queues = new Map<string, Promise<void>>()
  const openChatSkipLogged = new Set<string>()

  return async (target) => {
    if (target.adapter !== 'kakaotalk') return
    // No stop API: the indicator auto-expires ~5s after the last packet and a
    // delivered message clears it client-side, so 'stop' needs no packet.
    if (target.phase !== 'tick') return
    if (target.workspace === OPEN_CHAT_WORKSPACE) {
      if (!openChatSkipLogged.has(target.chat)) {
        openChatSkipLogged.add(target.chat)
        logger.info(`[kakaotalk:typing] skipped chat=${target.chat} reason=open_chat_link_id_unsupported`)
      }
      return
    }

    const prev = queues.get(target.chat) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(async () => {
        const result = await sendTyping(target.chat)
        if (!result.success) {
          throw new Error(`kakaotalk ACTION rejected: status_code=${result.status_code}`)
        }
      })
      .catch(async (err: unknown) => {
        const tag = formatChannelTag
          ? await formatChannelTag(target.workspace, target.chat).catch(() => `chat=${target.chat}`)
          : `chat=${target.chat}`
        logger.warn(`[kakaotalk:typing] ${tag} phase=${target.phase} failed: ${describeError(err)}`)
      })
    queues.set(target.chat, next)
    void next.finally(() => {
      if (queues.get(target.chat) === next) queues.delete(target.chat)
    })
    await next
  }
}
