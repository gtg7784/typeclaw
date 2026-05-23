import { parseSubagentCompletedPayload } from '@/agent/subagent-completion-reminder'
import type { Stream } from '@/stream'

import type { ChannelRouter } from './router'

export type SubagentCompletionBridgeLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

export type SubagentCompletionBridgeOptions = {
  stream: Stream
  router: Pick<ChannelRouter, 'injectSubagentCompletionReminder'>
  logger?: SubagentCompletionBridgeLogger
}

export type SubagentCompletionBridge = {
  stop: () => void
}

const consoleLogger: SubagentCompletionBridgeLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
}

// Bridges `subagent.completed` broadcasts on the in-process Stream into a
// channel router call so the channel session that spawned the subagent
// gets woken up with a `<system-reminder>` when the subagent finishes.
//
// Two-bridges-for-two-surfaces design (matches the TUI side at
// src/server/index.ts `routeSubagentCompletionReminder`):
//
//   - TUI sessions: the WS server subscribes to broadcasts on the same
//     stream and re-publishes the reminder as `target: { kind: 'session' }`
//     so the per-session drain loop in the server picks it up. Lookup is
//     by sessionId (which is `state.sessionFileId`).
//
//   - Channel sessions: this bridge subscribes and calls
//     `router.injectSubagentCompletionReminder` because the channel router
//     owns its own per-key drain loop and doesn't use the stream's
//     session-keyed target.
//
// `parentSessionId` matching is the same on both sides: when a channel
// session spawns a subagent via `spawn_subagent`, the tool captures
// `sessionManager.getSessionId()` and publishes it as the broadcast's
// `parentSessionId`. That id is exactly what the router stores on each
// `LiveSession`, so the lookup is O(N) over live sessions with N small
// (one per active conversation).
//
// On `no-live-session`, we silently drop. The session may have rolled
// over due to SESSION_FRESHNESS_TTL_MS or been GC'd while the subagent
// was running, in which case the reminder has nowhere to land. A
// follow-up could persist the reminder for rehydration, but that
// requires storing it next to channels/sessions.json and gating the
// next inbound on it — deferred until we see this drop pattern in
// practice.
export function createSubagentCompletionBridge(options: SubagentCompletionBridgeOptions): SubagentCompletionBridge {
  const logger = options.logger ?? consoleLogger
  const unsubscribe = options.stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
    const parsed = parseSubagentCompletedPayload(msg.payload)
    if (parsed === null) return
    const result = options.router.injectSubagentCompletionReminder(parsed)
    if (result.kind === 'no-live-session') {
      logger.info(
        `[channels] subagent-completion reminder dropped: no live session for parentSessionId=${parsed.parentSessionId} task=${parsed.taskId}`,
      )
    }
  })
  return { stop: unsubscribe }
}
