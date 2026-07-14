import type { KakaoTypingResult } from 'agent-messenger/kakaotalk'

import type { TypingCallback, TypingTarget } from '@/channels/types'

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
  shutdown: () => void
}

// KakaoTalk auto-expires the composing indicator ~5s after the last ACTION
// packet, but the router heartbeat fires every TYPING_HEARTBEAT_MS=8s — a 3s
// gap that would visibly blink the indicator off-and-on for the recipient. We
// self-refresh internally faster than the carrier expiry so the indicator stays
// continuously visible between router ticks. 4000ms sits ~20% below the 5s
// expiry — enough headroom for network jitter without burning a packet every 3s.
export const KAKAO_TYPING_REFRESH_MS = 4000

export function createKakaoTypingCallback(deps: {
  logger: KakaoTypingLogger
  sendTyping: KakaoTypingSender
  formatChannelTag?: (workspace: string, chat: string) => Promise<string>
  refreshIntervalMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}): KakaoTypingCallbackHandle {
  const { logger, sendTyping, formatChannelTag } = deps
  const refreshIntervalMs = deps.refreshIntervalMs ?? KAKAO_TYPING_REFRESH_MS
  const setIntervalImpl = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown)
  const clearIntervalImpl =
    deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  // Per-chat FIFO mirrors the webex/slack pattern: a slow start-typing must not
  // resolve after a follow-up stop-typing and strand the indicator on. We chain
  // every request through the per-chat tail so on-the-wire order matches the
  // enqueue order even when the network is jittery.
  const queues = new Map<string, Promise<void>>()
  // Per-chat self-refresh timers. Router fires `tick` every 8s but KakaoTalk
  // expires the indicator after ~5s, so we maintain our own faster refresh
  // between router ticks. A new tick resets the timer; a stop clears it.
  const refreshTimers = new Map<string, unknown>()
  const targetByChat = new Map<string, TypingTarget>()

  const enqueue = (target: TypingTarget): Promise<void> => {
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
    return next
  }

  const clearRefresh = (chat: string): void => {
    const handle = refreshTimers.get(chat)
    if (handle !== undefined) {
      clearIntervalImpl(handle)
      refreshTimers.delete(chat)
    }
    targetByChat.delete(chat)
  }

  const startRefresh = (target: TypingTarget): void => {
    clearRefresh(target.chat)
    targetByChat.set(target.chat, target)
    const handle = setIntervalImpl(() => {
      const t = targetByChat.get(target.chat)
      if (t === undefined) return
      void enqueue(t)
    }, refreshIntervalMs)
    refreshTimers.set(target.chat, handle)
  }

  const callback: TypingCallback = async (target) => {
    if (target.adapter !== 'kakaotalk') return
    if (target.phase === 'tick') {
      startRefresh(target)
      await enqueue(target)
      return
    }
    clearRefresh(target.chat)
  }

  const shutdown = (): void => {
    // oxlint-disable-next-line no-useless-spread -- snapshot so clearRefresh can delete from refreshTimers mid-iteration
    for (const chat of [...refreshTimers.keys()]) clearRefresh(chat)
  }

  return { callback, shutdown }
}
