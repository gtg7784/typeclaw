import type { SessionOrigin } from '@/agent/session-origin'

// A todo scope is the durable identity a todo list hangs off. It is
// deliberately NOT the raw sessionId: sessionIds churn across TUI reconnects
// and every cron fire, and a channel session can roll to a fresh sessionId on
// stale-rollover (see src/channels/router.ts SESSION_FRESHNESS_TTL_MS). Keying
// on origin identity instead lets a todo list survive those transitions so
// interrupted work can be resumed.
//
// `key` is a filesystem-safe relative path segment (no leading slash, no `..`).
// `kind` mirrors the originating `SessionOrigin['kind']` so the continuation
// injector can enforce that a nudge only fires into a live session whose origin
// matches the scope (the eligible-session invariant).
export type TodoScope = {
  kind: 'tui' | 'channel' | 'cron'
  key: string
}

// Resolve the durable todo scope for a session origin, or `null` when the
// origin owns no todo list.
//
// - tui      → singleton `tui`. There is no stable per-operator identity (the
//              sessionId churns on every reconnect and the restart handoff is
//              once-per-boot), so TUI is modeled as one global workstream per
//              agent. Concurrent TUI attaches therefore share a scope; this is
//              an accepted, documented limitation.
// - channel  → keyed by the adapter/workspace/chat/thread tuple, matching how
//              channels/sessions.json already identifies a conversation. This
//              survives both container restart and stale-rollover.
// - cron     → keyed by jobId. The sessionId is useless here (fresh every
//              fire); the job is the durable identity.
// - subagent → null. Subagents do not own continuation; their parent does.
// - system   → null. Runtime infrastructure (memory/backup) is not
//              user-delegated work and must never auto-continue.
export function resolveTodoScope(origin: SessionOrigin): TodoScope | null {
  switch (origin.kind) {
    case 'tui':
      return { kind: 'tui', key: 'tui' }
    case 'channel':
      return { kind: 'channel', key: channelScopeKey(origin) }
    case 'cron':
      return { kind: 'cron', key: `cron/${sanitizeSegment(origin.jobId)}` }
    case 'subagent':
    case 'system':
      return null
    default: {
      const _exhaustive: never = origin
      void _exhaustive
      return null
    }
  }
}

function channelScopeKey(origin: { adapter: string; workspace: string; chat: string; thread: string | null }): string {
  const parts = [origin.adapter, origin.workspace, origin.chat, origin.thread ?? '_root']
  return `channel/${parts.map(sanitizeSegment).join(':')}`
}

// Collapse anything that is not a safe filename character to `-`. Channel ids
// can contain slashes, colons, spaces, and other separators (Slack thread ids,
// KakaoTalk chat ids), any of which would otherwise escape the todo/ directory
// or collide path segments. The mapping is not reversible — it does not need to
// be, since the scope key is only ever compared for equality and used as a
// filename, never parsed back into its parts.
function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-')
  return cleaned === '' ? '_' : cleaned
}
