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
// On `no-live-session`, we silently drop. Three observable paths reach
// this branch in production:
//
//   - The parent session was GC'd by the idle-eviction tick
//     (SESSION_IDLE_MS) while the subagent was running.
//   - The parent session rolled over (SESSION_FRESHNESS_TTL_MS) when a
//     new inbound arrived during a long-running subagent — the channel
//     conversation continues on the new sessionId, but the broadcast
//     still carries the old one.
//   - The parent was a TUI session (the TUI bridge in
//     src/server/index.ts handles it).
//
// The right fix for the first two paths is for the broadcast to carry
// the channel-key coordinate `{ adapter, workspace, chat, thread }` so
// the bridge can fall back to "any live session for the same channel
// key" when the exact sessionId no longer matches. That requires
// extending the broadcast payload (consumed by TUI and channel paths)
// and gating spawn_subagent to capture the origin coordinates — both
// non-trivial. Deferred until we see this drop pattern in production
// logs; the info log line below makes the case diagnosable from logs
// alone.
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
