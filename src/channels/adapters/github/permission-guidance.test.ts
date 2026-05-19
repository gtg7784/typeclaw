import { describe, expect, test } from 'bun:test'

import { buildPermissionGuidance, parseListHooksPermissionStatus } from './index'

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
