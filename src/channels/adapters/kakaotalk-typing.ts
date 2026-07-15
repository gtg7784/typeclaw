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

export type KakaoTypingCallbackHandle = {
  callback: TypingCallback
  // Invalidate every in-flight/queued pulse. Called on adapter stop so a pulse
  // already accepted into a per-chat queue cannot reach the wire after teardown.
  reset: () => void
}

// KakaoTalk auto-expires the composing indicator ~5s after the last ACTION
// packet. The router paces the refresh via a heartbeat the adapter registers
// (setTypingHeartbeatInterval), so this callback holds no timer of its own.
// 4000ms sits ~20% below the ~5s expiry so a replacement packet lands before
// expiry even with scheduler/network jitter (a 5000ms interval has no margin).
export const KAKAO_TYPING_HEARTBEAT_MS = 4000

// Per-chat send decision, resolved live at each tick:
//   send             — authoritative DM/group, OR provisional. Emit the packet.
//   skip-open        — confirmed OpenChat; the LOCO ACTION needs a `linkId` the
//                      resolver does not surface today (logged once).
//   skip-unresolved  — chat unknown to the resolver; skip silently.
//
// Provisional entries send on purpose. A chat getChats never surfaces (e.g. a
// stale sub-device session returns a partial list) stays provisional forever, so
// skipping it disabled typing for exactly the chats a user actively messages. The
// inbound push proves the chat is real; the provisional bucket is @kakao-group
// (never @kakao-open), and a provisional-that-is-actually-OpenChat fails soft —
// sendTyping throws on non-success and the callback swallows it as a warn.
export type KakaoTypingChatClass = 'send' | 'skip-open' | 'skip-unresolved'

export function kakaoTypingClassFromLookup(
  lookup: { workspace: string; provisional: boolean } | null,
): KakaoTypingChatClass {
  if (lookup === null) return 'skip-unresolved'
  if (lookup.workspace === '@kakao-open') return 'skip-open'
  return 'send'
}

export function createKakaoTypingCallback(deps: {
  logger: KakaoTypingLogger
  sendTyping: KakaoTypingSender
  // Live per-chat classifier — consults the channel resolver at send time, not
  // the (stale) session-key target: an unknown room is skipped, a room confirmed
  // as OpenChat after the session key was minted is skipped, and a provisional or
  // authoritative DM/group room sends.
  classifyChat: (chatId: string) => KakaoTypingChatClass
  formatChannelTag?: (workspace: string, chat: string) => Promise<string>
}): KakaoTypingCallbackHandle {
  const { logger, sendTyping, classifyChat, formatChannelTag } = deps
  // Per-chat FIFO mirrors the webex/slack pattern: chaining each request through
  // the per-chat tail keeps on-the-wire order matching enqueue order even under
  // network jitter, so a slow send can't reorder behind a later tick.
  const queues = new Map<string, Promise<void>>()
  // Per-chat generation token, independent of any timer. A pulse captures the
  // chat's generation when it's accepted and re-checks it immediately before
  // sending; 'stop' and `reset` delete the generation, so a pulse already queued
  // behind an in-flight send is dropped instead of raising the indicator after
  // the turn (or the adapter) has stopped.
  const activeGeneration = new Map<string, number>()
  const openChatSkipLogged = new Set<string>()
  let generationCounter = 0

  const callback: TypingCallback = async (target) => {
    if (target.adapter !== 'kakaotalk') return
    // No stop API: the indicator auto-expires ~5s after the last packet and a
    // delivered message clears it client-side, so 'stop' sends no packet. It
    // must still invalidate any queued pulse for this chat.
    if (target.phase !== 'tick') {
      activeGeneration.delete(target.chat)
      return
    }
    const chatClass = classifyChat(target.chat)
    if (chatClass !== 'send') {
      if (chatClass === 'skip-open' && !openChatSkipLogged.has(target.chat)) {
        openChatSkipLogged.add(target.chat)
        logger.info(`[kakaotalk:typing] skipped chat=${target.chat} reason=open_chat_link_id_unsupported`)
      }
      return
    }

    if (!activeGeneration.has(target.chat)) activeGeneration.set(target.chat, ++generationCounter)
    const generation = activeGeneration.get(target.chat)
    const prev = queues.get(target.chat) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(async () => {
        if (activeGeneration.get(target.chat) !== generation) return
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

  const reset = (): void => {
    activeGeneration.clear()
  }

  return { callback, reset }
}
