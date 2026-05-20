import { describe, expect, test } from 'bun:test'

import type { SessionOrigin } from '@/agent/session-origin'

import { BUILTIN_ROLES, expandOwnerWildcard } from './builtins'
import { createPermissionService } from './permissions'
import { rolesConfigSchema, type RolesConfig } from './schema'

function parseRoles(raw: unknown): RolesConfig {
  const result = rolesConfigSchema.safeParse(raw)
  if (!result.success) throw new Error(`roles invalid: ${result.error.message}`)
  return result.data
}

const PLUGIN_PERMS = [
  'security.bypass.secretExfilBash',
  'security.bypass.gitExfil',
  'security.bypass.secretExfilRead',
] as const

const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }
const slackOwnerChat: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'C_GEN',
  thread: null,
  lastInboundAuthorId: 'U_ME',
}
const slackStrangerChat: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'C_GEN',
  thread: null,
  lastInboundAuthorId: 'U_STRANGER',
}

describe('PermissionService — defaults', () => {
  test('undefined origin → guest', () => {
    const svc = createPermissionService()
    expect(svc.resolveRole(undefined)).toBe('guest')
    expect(svc.has(undefined, 'channel.respond')).toBe(false)
  })

  test('tui origin → owner via built-in match', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(tui)).toBe('owner')
    expect(svc.has(tui, 'channel.respond')).toBe(true)
    expect(svc.has(tui, 'cron.schedule')).toBe(true)
    expect(svc.has(tui, 'cron.modify')).toBe(true)
    expect(svc.has(tui, 'security.bypass.secretExfilBash')).toBe(true)
    expect(svc.has(tui, 'security.bypass.gitExfil')).toBe(true)
  })

  test('channel origin with no roles → guest', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('guest')
    expect(svc.has(slackOwnerChat, 'channel.respond')).toBe(false)
  })
})

describe('PermissionService — user-declared roles', () => {
  test('trusted role with channel match grants channel.respond + bypass.low; per-guard medium/high bypasses are NOT default', () => {
    const roles = parseRoles({
      trusted: { match: ['slack:T0123 author:U_ME'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.has(slackOwnerChat, 'channel.respond')).toBe(true)
    expect(svc.has(slackOwnerChat, 'security.bypass.low')).toBe(true)
    expect(svc.has(slackOwnerChat, 'security.bypass.secretExfilBash')).toBe(false)
    expect(svc.has(slackOwnerChat, 'security.bypass.gitExfil')).toBe(false)
    expect(svc.has(slackOwnerChat, 'security.bypass.gitRemoteTainted')).toBe(false)
  })

  test('stranger in same chat does not match author rule → guest', () => {
    const roles = parseRoles({
      trusted: { match: ['slack:T0123 author:U_ME'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackStrangerChat)).toBe('guest')
    expect(svc.has(slackStrangerChat, 'channel.respond')).toBe(false)
  })

  test('declaration order: first role with any matching pattern wins', () => {
    const roles = parseRoles({
      trusted: { match: ['slack:T0123 author:U_ME'] },
      member: { match: ['slack:T0123'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.resolveRole(slackStrangerChat)).toBe('member')
  })

  test('explicit permissions array replaces built-in (no merge)', () => {
    const roles = parseRoles({
      trusted: { match: ['slack:T0123 author:U_ME'], permissions: ['channel.respond'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.has(slackOwnerChat, 'channel.respond')).toBe(true)
    expect(svc.has(slackOwnerChat, 'security.bypass.secretExfilBash')).toBe(false)
  })

  test('owner user match appends to built-in tui match', () => {
    const roles = parseRoles({
      owner: { match: ['slack:T0123 author:U_ME'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(tui)).toBe('owner')
    expect(svc.resolveRole(slackOwnerChat)).toBe('owner')
  })

  test('custom role grants only the permissions it declares', () => {
    const roles = parseRoles({
      partner: { match: ['slack:T0123 author:U_PARTNER'], permissions: ['cron.schedule'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    const partner: SessionOrigin = { ...slackOwnerChat, lastInboundAuthorId: 'U_PARTNER' }
    expect(svc.resolveRole(partner)).toBe('partner')
    expect(svc.has(partner, 'cron.schedule')).toBe(true)
    expect(svc.has(partner, 'channel.respond')).toBe(false)
  })
})

describe('PermissionService — cron/subagent provenance', () => {
  test('cron session resolves to scheduledByRole directly', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const cronAsOwner: SessionOrigin = {
      kind: 'cron',
      jobId: 'backup',
      jobKind: 'prompt',
      scheduledByRole: 'owner',
    }
    expect(svc.resolveRole(cronAsOwner)).toBe('owner')
    expect(svc.has(cronAsOwner, 'security.bypass.secretExfilBash')).toBe(true)
  })

  test('cron without scheduledByRole → guest (no laundering)', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const cron: SessionOrigin = { kind: 'cron', jobId: 'j', jobKind: 'prompt' }
    expect(svc.resolveRole(cron)).toBe('guest')
  })

  test('cron with unknown role string → guest (forged role rejected)', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const cron: SessionOrigin = {
      kind: 'cron',
      jobId: 'j',
      jobKind: 'prompt',
      scheduledByRole: 'admin',
    }
    expect(svc.resolveRole(cron)).toBe('guest')
  })

  test('subagent inherits spawnedByRole', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const sub: SessionOrigin = {
      kind: 'subagent',
      subagent: 'memory-logger',
      parentSessionId: 'p',
      spawnedByRole: 'owner',
    }
    expect(svc.resolveRole(sub)).toBe('owner')
  })

  test('subagent without spawnedByRole → guest', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const sub: SessionOrigin = {
      kind: 'subagent',
      subagent: 'memory-logger',
      parentSessionId: 'p',
    }
    expect(svc.resolveRole(sub)).toBe('guest')
  })
})

describe('expandOwnerWildcard', () => {
  test('replaces sentinel with concrete bypass permissions', () => {
    const expanded = expandOwnerWildcard(BUILTIN_ROLES.owner.permissions, [
      'security.bypass.foo',
      'security.bypass.bar',
      'other.permission',
    ])
    expect(expanded).toContain('channel.respond')
    expect(expanded).toContain('cron.schedule')
    expect(expanded).toContain('security.bypass.foo')
    expect(expanded).toContain('security.bypass.bar')
    expect(expanded).not.toContain('other.permission')
    expect(expanded.some((p) => p.startsWith('__BUILTIN'))).toBe(false)
  })

  test('user-written wildcards are not honored (sentinel only)', () => {
    const expanded = expandOwnerWildcard(['*'], ['security.bypass.foo'])
    expect(expanded).toEqual(['*'])
  })
})

describe('describe()', () => {
  test('returns role name and permission list', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const desc = svc.describe(tui)
    expect(desc.role).toBe('owner')
    expect(desc.permissions).toContain('channel.respond')
    expect(desc.permissions).toContain('security.bypass.secretExfilBash')
  })

  test('undefined origin → guest with empty permissions', () => {
    const svc = createPermissionService()
    const desc = svc.describe(undefined)
    expect(desc.role).toBe('guest')
    expect(desc.permissions).toEqual([])
  })
})
