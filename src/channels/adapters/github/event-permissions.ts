// Maps a GitHub webhook event (in the form used in typeclaw.json#channels.github.eventAllowlist,
// e.g. "issue_comment.created" or just "issues") to the GitHub App "Repository permissions"
// key that gates BOTH receiving payload fields AND posting replies for that event family.
//
// Source: https://docs.github.com/en/webhooks/webhook-events-and-payloads (each event page
// links to the App permission it requires).
//
// The permission key on the LEFT is what github.com calls the permission in the App settings UI
// ("Issues", "Pull requests", "Discussions"); the value on the RIGHT is the snake_case key that
// appears in the `permissions` object on GET /app/installations/{id} responses. They MUST match
// the strings GitHub actually emits — these are checked at runtime against an installation grant
// map, not normalised.
export const EVENT_PERMISSION_KEY: Record<string, string> = {
  issues: 'issues',
  issue_comment: 'issues',
  pull_request: 'pull_requests',
  pull_request_review: 'pull_requests',
  pull_request_review_comment: 'pull_requests',
  pull_request_review_thread: 'pull_requests',
  discussion: 'discussions',
  discussion_comment: 'discussions',
  commit_comment: 'contents',
  push: 'contents',
}

// Human-readable label for each App permission key, mirroring github.com's
// "Repository permissions" section verbatim. Used in the preflight warning so
// users can grep for the exact string on the App settings page.
export const PERMISSION_UI_LABEL: Record<string, string> = {
  issues: 'Issues',
  pull_requests: 'Pull requests',
  discussions: 'Discussions',
  contents: 'Contents',
  metadata: 'Metadata',
}

export type GrantLevel = 'read' | 'write' | 'admin'

// Accepts both the dotted form ("issues.opened", as used in
// typeclaw.json#channels.github.eventAllowlist) and the bare event family
// ("issues", as used in webhook event-header names).
export function permissionKeyForEvent(event: string): string | null {
  const family = event.includes('.') ? event.slice(0, event.indexOf('.')) : event
  return EVENT_PERMISSION_KEY[family] ?? null
}

export type PermissionGap = {
  permissionKey: string
  uiLabel: string
  granted: GrantLevel | null
  events: string[]
  needsWrite: boolean
}

// Unknown allowlist items are silently ignored — forward-compat for events
// typeclaw doesn't yet know about. `needsWrite` is hardcoded true because
// channel_reply is today's only canonical exit; flip to a per-event flag the
// day a read-only github channel becomes a supported use case.
export function findPermissionGaps(
  eventAllowlist: readonly string[],
  installationPermissions: Readonly<Record<string, GrantLevel>>,
): PermissionGap[] {
  const eventsByKey = new Map<string, Set<string>>()
  for (const event of eventAllowlist) {
    const key = permissionKeyForEvent(event)
    if (key === null) continue
    if (!eventsByKey.has(key)) eventsByKey.set(key, new Set())
    eventsByKey.get(key)?.add(event)
  }
  const gaps: PermissionGap[] = []
  for (const [permissionKey, events] of eventsByKey) {
    const granted = installationPermissions[permissionKey] ?? null
    if (granted === 'write' || granted === 'admin') continue
    gaps.push({
      permissionKey,
      uiLabel: PERMISSION_UI_LABEL[permissionKey] ?? permissionKey,
      granted,
      events: [...events].sort(),
      needsWrite: true,
    })
  }
  return gaps.sort((a, b) => a.permissionKey.localeCompare(b.permissionKey))
}
