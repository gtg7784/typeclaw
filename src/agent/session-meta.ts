import type { SessionOrigin } from './session-origin'

export const SESSION_META_CUSTOM_TYPE = 'typeclaw.session-meta'

export type SessionMetaPayload = {
  origin: MinimalSessionOrigin
}

export type MinimalSessionOrigin =
  | { kind: 'tui' }
  | { kind: 'cron'; jobId: string; jobKind: 'prompt' | 'exec' | 'subagent' }
  | { kind: 'channel'; adapter: string; workspace: string; chat: string; thread: string | null }
  | { kind: 'subagent'; subagent: string; parentSessionId: string }

// Reduce a full SessionOrigin to the minimum projection persisted to disk.
// Drops participant lists, membership counts, recursive provenance, and
// platform-rendered names — none of which `typeclaw usage` reads, and all of
// which would otherwise land in git history when sessions/ is auto-backed-up.
// Kept as a separate function so the boundary between "data the LLM sees in
// the system prompt" (full origin) and "data persisted for usage reporting"
// (this projection) stays explicit.
export function sessionMetaPayload(origin: SessionOrigin): SessionMetaPayload {
  return { origin: minimalOrigin(origin) }
}

function minimalOrigin(origin: SessionOrigin): MinimalSessionOrigin {
  switch (origin.kind) {
    case 'tui':
      return { kind: 'tui' }
    case 'cron':
      return { kind: 'cron', jobId: origin.jobId, jobKind: origin.jobKind }
    case 'channel':
      return {
        kind: 'channel',
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
      }
    case 'subagent':
      return { kind: 'subagent', subagent: origin.subagent, parentSessionId: origin.parentSessionId }
  }
}
