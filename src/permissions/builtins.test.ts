import { describe, expect, test } from 'bun:test'

import { BUILTIN_ROLE_NAMES, BUILTIN_ROLES, OWNER_SECURITY_WILDCARD } from './builtins'

describe('built-in role contract', () => {
  test('has exactly the four documented names in declaration order', () => {
    expect(BUILTIN_ROLE_NAMES).toEqual(['owner', 'trusted', 'member', 'guest'])
  })

  test('owner has tui in its built-in match and includes the security wildcard sentinel', () => {
    expect(BUILTIN_ROLES.owner.match).toEqual([{ kind: 'tui' }])
    expect(BUILTIN_ROLES.owner.permissions).toContain(OWNER_SECURITY_WILDCARD)
    expect(BUILTIN_ROLES.owner.permissions).toContain('channel.respond')
    expect(BUILTIN_ROLES.owner.permissions).toContain('cron.schedule')
    expect(BUILTIN_ROLES.owner.permissions).toContain('cron.modify')
  })

  test('trusted has empty default match and the documented permissions', () => {
    expect(BUILTIN_ROLES.trusted.match).toEqual([])
    expect([...BUILTIN_ROLES.trusted.permissions].sort()).toEqual([
      'channel.respond',
      'cron.schedule',
      'security.bypass.secretExfilBash',
    ])
  })

  test('member has empty default match and only channel.respond', () => {
    expect(BUILTIN_ROLES.member.match).toEqual([])
    expect([...BUILTIN_ROLES.member.permissions]).toEqual(['channel.respond'])
  })

  test('guest has no match and no permissions', () => {
    expect(BUILTIN_ROLES.guest.match).toEqual([])
    expect([...BUILTIN_ROLES.guest.permissions]).toEqual([])
  })
})
