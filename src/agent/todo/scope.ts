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
      return { kind: 'cron', key: `cron/${encodeSegment(origin.jobId)}` }
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
  // A null thread (channel-root session) is tagged distinctly from any real
  // thread id: `0:` vs `1:<encoded>`. A real thread whose literal text is
  // `_root` (or anything else) can never collide with the null-thread case,
  // because the discriminant prefix differs.
  const thread = origin.thread === null ? '0:' : `1:${encodeSegment(origin.thread)}`
  const parts = [encodeSegment(origin.adapter), encodeSegment(origin.workspace), encodeSegment(origin.chat), thread]
  return `channel/${parts.join(':')}`
}

// Encode a scope component collision-free. `encodeURIComponent` is injective
// and its output is filesystem-safe (it never emits `/` or `:` and percent-
// escapes everything outside an unreserved set), so distinct origin components
// can never alias to the same path — `a/b`, `a-b`, and `a:b` all map to
// distinct encodings. Reversibility is not required; injectivity is, because
// the key identifies which conversation's todo file is read or written.
function encodeSegment(value: string): string {
  const encoded = encodeURIComponent(value)
  return encoded === '' ? '_empty' : encoded
}
