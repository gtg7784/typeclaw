import type { SessionSummary } from './session-list'

// At most one item is `writable` (the live TUI session); every other session is
// read-only. `logs` carries no session — it is container stdout, available even
// when the agent server is down.
export type ViewerItem =
  | { kind: 'session'; summary: SessionSummary; writable: false }
  | { kind: 'tui'; summary: SessionSummary; writable: true }
  | { kind: 'logs' }

export function isWritable(item: ViewerItem): item is Extract<ViewerItem, { kind: 'tui' }> {
  return item.kind === 'tui'
}

export function itemKey(item: ViewerItem): string {
  return item.kind === 'logs' ? 'logs' : item.summary.sessionId
}
