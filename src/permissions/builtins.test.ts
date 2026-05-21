import { describe, expect, test } from 'bun:test'

import { BUILTIN_ROLE_NAMES, BUILTIN_ROLES, OWNER_SECURITY_WILDCARD, expandOwnerWildcard } from './builtins'

describe('built-in role contract', () => {
  test('has exactly the four documented names in declaration order', () => {
    expect(BUILTIN_ROLE_NAMES).toEqual(['owner', 'trusted', 'member', 'guest'])
  })

  test('owner pre-expansion: tui match, core perms, bypass.low + bypass.medium tier strings, wildcard sentinel', () => {
    expect(BUILTIN_ROLES.owner.match).toEqual([{ kind: 'tui' }])
    expect(BUILTIN_ROLES.owner.permissions).toContain(OWNER_SECURITY_WILDCARD)
    expect(BUILTIN_ROLES.owner.permissions).toContain('channel.respond')
    expect(BUILTIN_ROLES.owner.permissions).toContain('cron.schedule')
    expect(BUILTIN_ROLES.owner.permissions).toContain('cron.modify')
    expect(BUILTIN_ROLES.owner.permissions).toContain('security.bypass.low')
    expect(BUILTIN_ROLES.owner.permissions).toContain('security.bypass.medium')
  })

  test('owner pre-expansion does NOT carry security.bypass.high (high-tier requires per-call ack from every role)', () => {
    expect([...BUILTIN_ROLES.owner.permissions]).not.toContain('security.bypass.high')
  })

  test('owner carries all three subagent permissions (spawn / cancel / output) AND the operator-specific spawn permission', () => {
    expect(BUILTIN_ROLES.owner.permissions).toContain('subagent.spawn')
    expect(BUILTIN_ROLES.owner.permissions).toContain('subagent.cancel')
    expect(BUILTIN_ROLES.owner.permissions).toContain('subagent.output')
    expect(BUILTIN_ROLES.owner.permissions).toContain('subagent.spawn.operator')
  })

  test('trusted has empty default match and core perms + bypass.low + subagent perms + operator-specific spawn (no per-guard medium/high grants)', () => {
    expect(BUILTIN_ROLES.trusted.match).toEqual([])
    expect([...BUILTIN_ROLES.trusted.permissions].sort()).toEqual([
      'channel.respond',
      'cron.schedule',
      'security.bypass.low',
      'subagent.cancel',
      'subagent.output',
      'subagent.spawn',
      'subagent.spawn.operator',
    ])
  })

  test('trusted does NOT carry bypass.medium or bypass.high (only low tier by default)', () => {
    expect([...BUILTIN_ROLES.trusted.permissions]).not.toContain('security.bypass.medium')
    expect([...BUILTIN_ROLES.trusted.permissions]).not.toContain('security.bypass.high')
  })

  test('trusted does NOT carry per-guard bypassGitExfil / bypassSecretExfilBash (use explicit grant in typeclaw.json to re-open)', () => {
    expect([...BUILTIN_ROLES.trusted.permissions]).not.toContain('security.bypass.gitExfil')
    expect([...BUILTIN_ROLES.trusted.permissions]).not.toContain('security.bypass.secretExfilBash')
  })

  test('member has empty default match and channel.respond + subagent perms (agent-side proactive fan-out)', () => {
    expect(BUILTIN_ROLES.member.match).toEqual([])
    expect([...BUILTIN_ROLES.member.permissions].sort()).toEqual([
      'channel.respond',
      'subagent.cancel',
      'subagent.output',
      'subagent.spawn',
    ])
  })

  test('member does NOT carry the operator-specific spawn permission (write-capable subagents are owner+trusted only)', () => {
    expect([...BUILTIN_ROLES.member.permissions]).not.toContain('subagent.spawn.operator')
  })

  test('member does NOT carry security bypass (subagent.spawn does not imply write capability — explorer is read-only, operator is gated separately via subagent.spawn.operator)', () => {
    expect([...BUILTIN_ROLES.member.permissions]).not.toContain('security.bypass.low')
    expect([...BUILTIN_ROLES.member.permissions]).not.toContain('security.bypass.medium')
  })

  test('guest has no match and no permissions', () => {
    expect(BUILTIN_ROLES.guest.match).toEqual([])
    expect([...BUILTIN_ROLES.guest.permissions]).toEqual([])
  })
})

describe('owner-wildcard runtime expansion (audience-leak guards stay off)', () => {
  // Mirror the production security plugin's contribution. If the security
  // plugin's HIGH_TIER_PER_GUARD_PERMISSIONS list grows, the corresponding
  // assertion in src/bundled-plugins/security/permissions.test.ts catches
  // the drift; this test asserts the wildcard expander honors whatever
  // list it's given.
  const PLUGIN_BYPASS_PERMS = [
    'security.bypass.secretExfilBash',
    'security.bypass.gitExfil',
    'security.bypass.secretExfilRead',
    'security.bypass.ssrf',
    'security.bypass.sessionSearchSecrets',
    'security.bypass.systemPromptLeak',
    'security.bypass.outboundSecret',
    'security.bypass.gitRemoteTainted',
    'security.bypass.low',
    'security.bypass.medium',
    'security.bypass.high',
  ]
  const HIGH_TIER_EXCLUSIONS = [
    'security.bypass.gitExfil',
    'security.bypass.gitRemoteTainted',
    'security.bypass.outboundSecret',
    'security.bypass.systemPromptLeak',
    'security.bypass.high',
  ]

  test('owner runtime perms: every plugin-contributed security.bypass.* EXCEPT the high-tier exclusions', () => {
    const expanded = expandOwnerWildcard(BUILTIN_ROLES.owner.permissions, PLUGIN_BYPASS_PERMS, HIGH_TIER_EXCLUSIONS)

    // Medium-tier per-guard strings: present (wildcard expanded to them)
    expect(expanded).toContain('security.bypass.secretExfilBash')
    expect(expanded).toContain('security.bypass.secretExfilRead')
    expect(expanded).toContain('security.bypass.ssrf')
    expect(expanded).toContain('security.bypass.sessionSearchSecrets')

    // High-tier per-guard strings: absent (audience-leak rule — owner must ack)
    expect(expanded).not.toContain('security.bypass.gitExfil')
    expect(expanded).not.toContain('security.bypass.gitRemoteTainted')
    expect(expanded).not.toContain('security.bypass.outboundSecret')
    expect(expanded).not.toContain('security.bypass.systemPromptLeak')

    // Tier strings: low + medium present (explicit in BUILTIN_ROLES.owner),
    // high absent (excluded AND not explicit).
    expect(expanded).toContain('security.bypass.low')
    expect(expanded).toContain('security.bypass.medium')
    expect(expanded).not.toContain('security.bypass.high')
  })

  test('operator override: explicit security.bypass.gitExfil in owner.permissions still takes effect (flows through non-sentinel branch)', () => {
    const overridden = [...BUILTIN_ROLES.owner.permissions, 'security.bypass.gitExfil']
    const expanded = expandOwnerWildcard(overridden, PLUGIN_BYPASS_PERMS, HIGH_TIER_EXCLUSIONS)
    expect(expanded).toContain('security.bypass.gitExfil')
  })
})
