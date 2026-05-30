import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILTIN_ROLES } from './builtins'
import { grantRole, grantRolePermission } from './grant'

function freshAgentDir(initialConfig: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-grant-test-'))
  writeFileSync(join(dir, 'typeclaw.json'), `${JSON.stringify(initialConfig, null, 2)}\n`)
  return dir
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'typeclaw.json'), 'utf8'))
}

describe('grantRole', () => {
  test('appends to roles.<name>.match, creating the block when missing', () => {
    const dir = freshAgentDir({ model: 'openai/gpt-4o-mini' })
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:T0123 author:U_ME' })
    expect(result).toEqual({ ok: true, added: true })

    const config = readConfig(dir)
    expect(config.roles).toEqual({
      owner: { match: ['slack:T0123 author:U_ME'] },
    })
    expect(config.model).toBe('openai/gpt-4o-mini')
  })

  test('idempotent: re-granting same rule returns added: false', () => {
    const dir = freshAgentDir({
      roles: { owner: { match: ['slack:T0123 author:U_ME'] } },
    })
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:T0123 author:U_ME' })
    expect(result).toEqual({ ok: true, added: false })
  })

  test('appends to existing match list without duplicating', () => {
    const dir = freshAgentDir({
      roles: { owner: { match: ['tui'] } },
    })
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:T0123 author:U_ME' })
    expect(result).toEqual({ ok: true, added: true })

    const config = readConfig(dir) as { roles: { owner: { match: string[] } } }
    expect(config.roles.owner.match).toEqual(['tui', 'slack:T0123 author:U_ME'])
  })

  test('creates new role block when the role is not yet declared', () => {
    const dir = freshAgentDir({})
    const result = grantRole({ cwd: dir, roleName: 'member', matchRule: 'slack:T0123 author:U_BOB' })
    expect(result).toEqual({ ok: true, added: true })

    const config = readConfig(dir) as { roles: { member: { match: string[] } } }
    expect(config.roles.member.match).toEqual(['slack:T0123 author:U_BOB'])
  })

  test('rejects malformed match rules', () => {
    const dir = freshAgentDir({})
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'team:T0123' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("legacy prefix 'team'")
    }
  })

  test('rejects missing typeclaw.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typeclaw-grant-test-'))
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'tui' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('not found')
    }
  })

  test('rejects invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typeclaw-grant-test-'))
    writeFileSync(join(dir, 'typeclaw.json'), '{ not valid json')
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'tui' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('not valid JSON')
    }
  })

  test('preserves unrelated fields and existing roles', () => {
    const dir = freshAgentDir({
      model: 'openai/gpt-4o-mini',
      channels: { 'slack-bot': {} },
      roles: {
        owner: { match: ['tui'] },
        member: { match: ['slack:T0123'] },
      },
    })
    grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:T0123 author:U_ME' })

    const config = readConfig(dir) as {
      model: string
      channels: Record<string, unknown>
      roles: Record<string, { match: string[] } | undefined>
    }
    expect(config.model).toBe('openai/gpt-4o-mini')
    expect(config.channels).toEqual({ 'slack-bot': {} })
    expect(config.roles.owner?.match).toEqual(['tui', 'slack:T0123 author:U_ME'])
    expect(config.roles.member?.match).toEqual(['slack:T0123'])
  })
})

describe('grantRolePermission', () => {
  test('granting a permission to a built-in role with NO explicit permissions materializes defaults + new perm (does NOT narrow)', () => {
    // given: guest has no explicit permissions[] in the file (uses defaults)
    const dir = freshAgentDir({ roles: { guest: { match: ['discord:*'] } } })

    // when: an operator grants guest channel.respond
    const result = grantRolePermission({ cwd: dir, roleName: 'guest', permission: 'channel.respond' })
    expect(result).toEqual({ ok: true, added: true })

    // then: the written set is guest's built-in defaults (empty) + the new perm,
    // NOT a narrowing to some other shape; match is preserved
    const config = readConfig(dir) as { roles: { guest: { match: string[]; permissions: string[] } } }
    expect(config.roles.guest.permissions).toEqual([...BUILTIN_ROLES.guest.permissions, 'channel.respond'])
    expect(config.roles.guest.match).toEqual(['discord:*'])
  })

  test('granting to a built-in role preserves its FULL default capability set (member is not narrowed to one perm)', () => {
    const dir = freshAgentDir({ roles: { member: { match: ['slack:T0123'] } } })

    grantRolePermission({ cwd: dir, roleName: 'member', permission: 'cron.schedule' })

    const config = readConfig(dir) as { roles: { member: { permissions: string[] } } }
    // every built-in member default must survive the grant
    for (const p of BUILTIN_ROLES.member.permissions) {
      expect(config.roles.member.permissions).toContain(p)
    }
    expect(config.roles.member.permissions).toContain('cron.schedule')
  })

  test('appends to an explicit permissions[] without clobbering it', () => {
    const dir = freshAgentDir({
      roles: { guest: { match: ['discord:*'], permissions: ['channel.respond'] } },
    })
    grantRolePermission({ cwd: dir, roleName: 'guest', permission: 'fs.see.private' })

    const config = readConfig(dir) as { roles: { guest: { permissions: string[] } } }
    expect(config.roles.guest.permissions).toEqual(['channel.respond', 'fs.see.private'])
  })

  test('idempotent: granting a permission the role already effectively holds is a no-op', () => {
    // member's defaults already include channel.respond
    const dir = freshAgentDir({ roles: { member: { match: ['slack:T0123'] } } })
    const result = grantRolePermission({ cwd: dir, roleName: 'member', permission: 'channel.respond' })
    expect(result).toEqual({ ok: true, added: false })

    const config = readConfig(dir) as { roles: { member: { permissions?: string[] } } }
    // no narrowing write happened; the file role still has no explicit permissions[]
    expect(config.roles.member.permissions).toBeUndefined()
  })
})
