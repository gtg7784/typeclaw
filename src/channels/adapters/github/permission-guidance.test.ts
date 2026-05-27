import { describe, expect, test } from 'bun:test'

import {
  buildAppPermissionPreflightGuidance,
  buildOutboundPermissionGuidance,
  buildPermissionGuidance,
  isOutboundPermissionDenial,
  parseListHooksPermissionStatus,
} from './permission-guidance'

describe('parseListHooksPermissionStatus', () => {
  test('returns 404 for a 404 list-hooks error', () => {
    expect(parseListHooksPermissionStatus('list hooks failed: 404 {"message":"Not Found"}')).toBe(404)
  })

  test('returns 403 for a 403 list-hooks error', () => {
    expect(parseListHooksPermissionStatus('list hooks failed: 403 {"message":"Forbidden"}')).toBe(403)
  })

  test('returns null for a 500 list-hooks error (not a permission issue)', () => {
    expect(parseListHooksPermissionStatus('list hooks failed: 500 server error')).toBeNull()
  })

  test('returns null for a 401 list-hooks error (auth-config issue, not repo permission)', () => {
    expect(parseListHooksPermissionStatus('list hooks failed: 401 bad creds')).toBeNull()
  })

  test('returns null for a create-hook 403 (different code path, different remediation)', () => {
    expect(parseListHooksPermissionStatus('create hook failed: 403 forbidden')).toBeNull()
  })

  test('returns null for an invalid-slug error', () => {
    expect(parseListHooksPermissionStatus('invalid repo slug: "weird" (expected owner/name)')).toBeNull()
  })

  test('returns null for a network error', () => {
    expect(parseListHooksPermissionStatus('fetch failed: ECONNREFUSED')).toBeNull()
  })
})

describe('buildPermissionGuidance', () => {
  test('PAT guidance names the failing repos with status codes', () => {
    const msg = buildPermissionGuidance('pat', [
      { repo: 'indentcorp/huxley', status: 404 },
      { repo: 'indentcorp/dobby', status: 403 },
    ])
    expect(msg).toContain('indentcorp/huxley (404)')
    expect(msg).toContain('indentcorp/dobby (403)')
  })

  test('PAT guidance uses the exact github.com UI label "Resource owner"', () => {
    const msg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('"Resource owner"')
  })

  test('PAT guidance uses the exact github.com UI label "Repository access"', () => {
    const msg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('"Repository access"')
  })

  test('PAT guidance uses the exact github.com UI label "Repository permissions"', () => {
    const msg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('"Repository permissions"')
  })

  test('PAT guidance names "Webhooks" → "Read and write" verbatim (the actual permission row)', () => {
    const msg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('"Webhooks"')
    expect(msg).toContain('"Read and write"')
  })

  test('PAT guidance names "Metadata" → "Read-only" verbatim (silently required by fine-grained tokens)', () => {
    const msg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('"Metadata"')
    expect(msg).toContain('"Read-only"')
  })

  test('PAT guidance points at the fine-grained settings page URL', () => {
    const msg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('https://github.com/settings/personal-access-tokens')
  })

  test('PAT guidance covers the SAML SSO unlock path (the second-most-common cause)', () => {
    const msg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('SAML')
    expect(msg).toContain('Configure SSO')
  })

  test('PAT guidance mentions the classic-PAT fallback with the canonical scope name', () => {
    const msg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('admin:repo_hook')
  })

  test('PAT guidance does NOT mention GitHub App settings (would mislead the user)', () => {
    const msg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    expect(msg).not.toContain('https://github.com/settings/apps')
  })

  test('App guidance uses the exact UI label "Permissions & events"', () => {
    const msg = buildPermissionGuidance('app', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('"Permissions & events"')
  })

  test('App guidance names "Webhooks" → "Read and write" verbatim under "Repository permissions"', () => {
    const msg = buildPermissionGuidance('app', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('"Repository permissions"')
    expect(msg).toContain('"Webhooks"')
    expect(msg).toContain('"Read and write"')
  })

  test('App guidance points at the GitHub Apps settings page URL', () => {
    const msg = buildPermissionGuidance('app', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('https://github.com/settings/apps')
  })

  test('App guidance covers the install-or-configure step (apps are useless until installed)', () => {
    const msg = buildPermissionGuidance('app', [{ repo: 'acme/x', status: 404 }])
    expect(msg).toContain('Install App')
    expect(msg).toContain('Configure')
  })

  test('App guidance does NOT mention PAT-only concepts (Resource owner / SAML token authorization)', () => {
    const msg = buildPermissionGuidance('app', [{ repo: 'acme/x', status: 404 }])
    expect(msg).not.toContain('"Resource owner"')
    expect(msg).not.toContain('admin:repo_hook')
  })

  test('both variants explain why 404 means missing repo access (so the user does not think the repo is deleted)', () => {
    const patMsg = buildPermissionGuidance('pat', [{ repo: 'acme/x', status: 404 }])
    const appMsg = buildPermissionGuidance('app', [{ repo: 'acme/x', status: 404 }])
    expect(patMsg).toContain('404')
    expect(patMsg).toContain('hides private repos')
    expect(appMsg).toContain('404')
    expect(appMsg).toContain('hides private repos')
  })
})

describe('buildAppPermissionPreflightGuidance', () => {
  test('headlines with the number of missing permission families', () => {
    const msg = buildAppPermissionPreflightGuidance([
      { permissionKey: 'issues', uiLabel: 'Issues', granted: null, events: ['issues.opened'], needsWrite: true },
    ])
    expect(msg).toContain('missing permissions for 1 configured event family')
  })

  test('pluralises the headline when multiple families are missing', () => {
    const msg = buildAppPermissionPreflightGuidance([
      { permissionKey: 'issues', uiLabel: 'Issues', granted: null, events: ['issues.opened'], needsWrite: true },
      {
        permissionKey: 'pull_requests',
        uiLabel: 'Pull requests',
        granted: null,
        events: ['pull_request.opened'],
        needsWrite: true,
      },
    ])
    expect(msg).toContain('2 configured event families')
  })

  test('uses verbatim github.com UI labels for each gap', () => {
    const msg = buildAppPermissionPreflightGuidance([
      {
        permissionKey: 'pull_requests',
        uiLabel: 'Pull requests',
        granted: 'read',
        events: ['pull_request.opened'],
        needsWrite: true,
      },
    ])
    expect(msg).toContain('Pull requests: granted=read, need=Read and write')
    expect(msg).toContain('Permissions & events')
  })

  test('lists the events covered by each missing permission so the user knows what will fail', () => {
    const msg = buildAppPermissionPreflightGuidance([
      {
        permissionKey: 'issues',
        uiLabel: 'Issues',
        granted: null,
        events: ['issue_comment.created', 'issues.opened'],
        needsWrite: true,
      },
    ])
    expect(msg).toContain('covers: issue_comment.created, issues.opened')
  })

  test('reports granted=none when no grant exists at all (not "read" or "write")', () => {
    const msg = buildAppPermissionPreflightGuidance([
      {
        permissionKey: 'discussions',
        uiLabel: 'Discussions',
        granted: null,
        events: ['discussion.created'],
        needsWrite: true,
      },
    ])
    expect(msg).toContain('granted=none')
  })

  test('mentions the 403 message users will see if they ignore the warning', () => {
    const msg = buildAppPermissionPreflightGuidance([
      { permissionKey: 'issues', uiLabel: 'Issues', granted: null, events: ['issues.opened'], needsWrite: true },
    ])
    expect(msg).toContain('Resource not accessible by integration')
  })
})

describe('isOutboundPermissionDenial', () => {
  test('matches the exact GitHub body for a permission-denied integration', () => {
    expect(isOutboundPermissionDenial(403, '{"message":"Resource not accessible by integration"}')).toBe(true)
  })

  test('does not match other 403 bodies (e.g. org SSO)', () => {
    expect(isOutboundPermissionDenial(403, '{"message":"Resource protected by organization SAML enforcement."}')).toBe(
      false,
    )
  })

  test('does not match a permission-denial string on a non-403 status', () => {
    expect(isOutboundPermissionDenial(401, 'Resource not accessible by integration')).toBe(false)
    expect(isOutboundPermissionDenial(404, 'Resource not accessible by integration')).toBe(false)
  })

  test('matches when the denial string is embedded in a longer body', () => {
    expect(
      isOutboundPermissionDenial(403, '{"foo":1,"message":"Resource not accessible by integration","bar":2}'),
    ).toBe(true)
  })
})

describe('buildOutboundPermissionGuidance', () => {
  test('App + issue-comment names the "Issues" permission at "Read and write"', () => {
    const g = buildOutboundPermissionGuidance({ authType: 'app', endpointKind: 'issue-comment' })
    expect(g).toContain('Fix (GitHub App): the App needs "Issues" → "Read and write".')
    expect(g).toContain('Open the install page')
  })

  test('App + pr-review-reply names "Pull requests", not "Issues"', () => {
    const g = buildOutboundPermissionGuidance({ authType: 'app', endpointKind: 'pr-review-reply' })
    expect(g).toContain('"Pull requests" → "Read and write"')
    expect(g).not.toContain('"Issues" →')
  })

  test('App + discussion-comment names "Discussions"', () => {
    const g = buildOutboundPermissionGuidance({ authType: 'app', endpointKind: 'discussion-comment' })
    expect(g).toContain('"Discussions" → "Read and write"')
  })

  test('PAT + issue-comment names "Issues" for fine-grained and "repo" for classic', () => {
    const g = buildOutboundPermissionGuidance({ authType: 'pat', endpointKind: 'issue-comment' })
    expect(g).toContain('Fix (fine-grained personal access token)')
    expect(g).toContain('"Issues" → "Read and write"')
    expect(g).toContain('"repo (or public_repo for public repos)" scope')
  })

  test('PAT + discussion-comment uses the discussion-specific scope and label', () => {
    const g = buildOutboundPermissionGuidance({ authType: 'pat', endpointKind: 'discussion-comment' })
    expect(g).toContain('"Discussions" → "Read and write"')
    expect(g).toContain('"repo" scope')
  })

  test('App guidance reminds the user the install owner must reaccept the new permissions', () => {
    const g = buildOutboundPermissionGuidance({ authType: 'app', endpointKind: 'issue-comment' })
    expect(g).toContain('accept the updated permissions request')
  })
})
