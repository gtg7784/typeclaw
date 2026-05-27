import { describe, expect, it } from 'bun:test'

import { findPermissionGaps, permissionKeyForEvent } from './event-permissions'

describe('permissionKeyForEvent', () => {
  it('maps dotted event names to the permission family', () => {
    expect(permissionKeyForEvent('issue_comment.created')).toBe('issues')
    expect(permissionKeyForEvent('pull_request_review_comment.created')).toBe('pull_requests')
    expect(permissionKeyForEvent('discussion.created')).toBe('discussions')
  })

  it('maps bare event-family names to the permission family', () => {
    expect(permissionKeyForEvent('issues')).toBe('issues')
    expect(permissionKeyForEvent('pull_request_review')).toBe('pull_requests')
    expect(permissionKeyForEvent('discussion_comment')).toBe('discussions')
  })

  it('returns null for events typeclaw does not yet know about', () => {
    expect(permissionKeyForEvent('star.created')).toBeNull()
    expect(permissionKeyForEvent('marketplace_purchase.purchased')).toBeNull()
  })
})

describe('findPermissionGaps', () => {
  it('returns a gap when the App has zero relevant permissions', () => {
    const gaps = findPermissionGaps(['issues.opened', 'pull_request.opened'], {
      metadata: 'read',
      repository_hooks: 'write',
    })
    expect(gaps).toEqual([
      { permissionKey: 'issues', uiLabel: 'Issues', granted: null, events: ['issues.opened'], needsWrite: true },
      {
        permissionKey: 'pull_requests',
        uiLabel: 'Pull requests',
        granted: null,
        events: ['pull_request.opened'],
        needsWrite: true,
      },
    ])
  })

  it('returns a gap when the App has read but not write on a required permission', () => {
    const gaps = findPermissionGaps(['issues.opened'], { issues: 'read' })
    expect(gaps).toEqual([
      { permissionKey: 'issues', uiLabel: 'Issues', granted: 'read', events: ['issues.opened'], needsWrite: true },
    ])
  })

  it('returns no gaps when every required permission has write', () => {
    const gaps = findPermissionGaps(['issues.opened', 'pull_request_review_comment.created'], {
      issues: 'write',
      pull_requests: 'write',
    })
    expect(gaps).toEqual([])
  })

  it('treats admin as satisfying a write requirement', () => {
    const gaps = findPermissionGaps(['issues.opened'], { issues: 'admin' })
    expect(gaps).toEqual([])
  })

  it('coalesces multiple events under the same permission into a single gap', () => {
    const gaps = findPermissionGaps(['issues.opened', 'issue_comment.created', 'pull_request.opened'], {
      metadata: 'read',
    })
    expect(gaps).toHaveLength(2)
    const issues = gaps.find((g) => g.permissionKey === 'issues')
    expect(issues?.events).toEqual(['issue_comment.created', 'issues.opened'])
  })

  it('silently ignores allowlist entries it does not recognise', () => {
    const gaps = findPermissionGaps(['issues.opened', 'star.created', 'marketplace_purchase.purchased'], {
      issues: 'write',
    })
    expect(gaps).toEqual([])
  })

  it('sorts gaps by permission key for stable warning output', () => {
    const gaps = findPermissionGaps(['pull_request.opened', 'discussion.created', 'issues.opened'], {
      metadata: 'read',
    })
    expect(gaps.map((g) => g.permissionKey)).toEqual(['discussions', 'issues', 'pull_requests'])
  })
})
