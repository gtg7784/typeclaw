import type { PermissionGap } from './event-permissions'

export type GithubAuthType = 'pat' | 'app'

// Parses webhook-register errors of the shape `list hooks failed: <status> <body>`.
// Returns the status code when it matches the two shapes GitHub emits for
// missing access on the list-hooks endpoint:
//   - 404 Not Found: the token cannot see the repo at all (private repo
//     gated behind missing repository access — GitHub returns 404 instead of
//     403 to avoid leaking the existence of private repos).
//   - 403 Forbidden: the token sees the repo but lacks webhook-management
//     permission, OR is blocked by an org SSO/SAML authorization gate.
// Returns null for any other error (network, malformed slug, create-hook
// failures, etc.) so the guidance only fires on the actual symptom.
export function parseListHooksPermissionStatus(error: string): number | null {
  const match = error.match(/^list hooks failed: (404|403)\b/)
  if (match === null) return null
  return Number(match[1])
}

// The labels below intentionally mirror github.com's current UI verbatim so a
// user can grep their settings page for the exact string. If GitHub renames
// any of these in a future redesign, update both here and the
// `permissionGuidance` tests in lifecycle.test.ts.
//
//   Fine-grained PAT:
//     Settings → Developer settings → Personal access tokens → Fine-grained tokens
//     "Resource owner", "Repository access", "Repository permissions" → "Webhooks" → "Read and write", "Metadata" → "Read-only"
//   GitHub App:
//     Settings → Developer settings → GitHub Apps → <app> → Permissions & events
//     "Repository permissions" → "Webhooks" → "Read and write"
//     Install/configure on the org: <app settings> → Install App / Configure → "Repository access"
//   Classic PAT (legacy, still supported by GitHub but we don't surface it in
//     channel-add prompts):
//     Settings → Developer settings → Personal access tokens (classic)
//     Scope: "admin:repo_hook" (or full "repo" for private repositories)
export function buildPermissionGuidance(
  authType: GithubAuthType,
  failures: ReadonlyArray<{ repo: string; status: number }>,
): string {
  const repoList = failures.map((f) => `${f.repo} (${f.status})`).join(', ')
  const lines: string[] = [
    `[github] webhook setup needs more access for: ${repoList}.`,
    '  - 404 from GitHub means the token cannot see the repo (GitHub hides private repos behind 404 instead of 403).',
    '  - 403 means the token sees the repo but lacks webhook permission, or is blocked by org SAML/SSO.',
    '',
  ]
  if (authType === 'pat') {
    lines.push(
      '  Fix (fine-grained personal access token):',
      '    1. Open https://github.com/settings/personal-access-tokens and edit the token TypeClaw is using.',
      '    2. Under "Resource owner", select the org that owns the failing repos (e.g. the org in the slug above).',
      '    3. Under "Repository access", choose "Only select repositories" and add every failing repo (or pick "All repositories").',
      '    4. Under "Repository permissions", set "Webhooks" to "Read and write" and "Metadata" to "Read-only".',
      '    5. Save. If the org enforces SAML SSO, click "Configure SSO" next to the token and authorize the org.',
      '',
      '  Or (classic personal access token): grant the "admin:repo_hook" scope (or "repo" for private repos),',
      '  and on a SAML-protected org click "Authorize" next to the token.',
    )
  } else {
    lines.push(
      '  Fix (GitHub App):',
      '    1. Open https://github.com/settings/apps and edit the app TypeClaw is using.',
      '    2. Under "Permissions & events" → "Repository permissions", set "Webhooks" to "Read and write". Save.',
      '    3. From the app page, click "Install App" (or "Configure" if already installed) and select the org that owns the failing repos.',
      '    4. Under "Repository access", choose "Only select repositories" and add every failing repo (or pick "All repositories").',
      '    5. If the app permissions changed in step 2, install owners must accept the updated permissions from the install page before the new access takes effect.',
    )
  }
  return lines.join('\n')
}

// Always GitHub App: PATs don't have per-installation permission grants
// (their access is gated by token scopes, surfaced by the existing 404/403
// flow in webhook-register).
export function buildAppPermissionPreflightGuidance(gaps: ReadonlyArray<PermissionGap>): string {
  const lines = [
    `[github] GitHub App installation is missing permissions for ${gaps.length} configured event ${gaps.length === 1 ? 'family' : 'families'}:`,
  ]
  for (const gap of gaps) {
    const eventList = gap.events.join(', ')
    const grantedLabel = gap.granted === null ? 'none' : gap.granted
    const needLabel = gap.needsWrite ? 'Read and write' : 'Read-only'
    lines.push(`  - ${gap.uiLabel}: granted=${grantedLabel}, need=${needLabel} (covers: ${eventList})`)
  }
  lines.push(
    '',
    '  Fix:',
    '    1. Open https://github.com/settings/apps and edit the app TypeClaw is using.',
    '    2. Under "Permissions & events" → "Repository permissions", set each missing permission above to the listed level. Save.',
    '    3. Open the install page (Install App / Configure for the org) and accept the updated permissions request — the new access only takes effect after the install owner accepts.',
    '    4. If the org enforces SAML SSO, ensure the App is authorized for the org from the org settings → Third-party Apps page.',
    '',
    '  Webhooks already received will continue to deliver, but payload fields and reply attempts that require the missing permission will fail with 403 ("Resource not accessible by integration") until the install is reaccepted.',
  )
  return lines.join('\n')
}
