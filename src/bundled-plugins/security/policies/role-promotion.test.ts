import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ACKNOWLEDGE_GUARDS } from '../policy'
import { GUARD_ROLE_PROMOTION, checkRolePromotionGuard, diffRoles, sanitizeForReason } from './role-promotion'

async function makeAgentDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'typeclaw-role-promotion-'))
}

async function writeConfig(agentDir: string, config: unknown): Promise<void> {
  await writeFile(path.join(agentDir, 'typeclaw.json'), JSON.stringify(config, null, 2))
}

const BEFORE_BASELINE = {
  port: 9000,
  roles: {
    member: { match: ['slack:T000/C000'] },
    owner: { match: ['tui'] },
  },
}

describe('diffRoles — unit', () => {
  test('no-op when role tables are byte-identical', () => {
    expect(diffRoles({ owner: { match: [{ kind: 'tui' }] } }, { owner: { match: [{ kind: 'tui' }] } })).toEqual([])
  })

  test('flags a permission gain', () => {
    const findings = diffRoles(
      { trusted: { match: [], permissions: ['channel.respond'] } },
      { trusted: { match: [], permissions: ['channel.respond', 'security.bypass.gitExfil'] } },
    )
    expect(findings).toEqual([{ role: 'trusted', kind: 'permissions-added', added: ['security.bypass.gitExfil'] }])
  })

  test('flags a match widening (new author rule under existing role)', () => {
    const findings = diffRoles(
      { owner: { match: [{ kind: 'tui' }] } },
      {
        owner: {
          match: [{ kind: 'tui' }, { kind: 'channel', platform: 'slack', author: 'U_NEW' }],
        },
      },
    )
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe('match-added')
    expect(findings[0]?.added[0]).toBe('slack:* author:U_NEW')
  })

  test('flags introduction of a new role with a non-empty grant', () => {
    const findings = diffRoles({}, { admin: { match: [{ kind: 'tui' }], permissions: ['security.bypass.high'] } })
    expect(findings).toEqual([
      {
        role: 'admin',
        kind: 'role-added',
        added: ['permission:security.bypass.high', 'match:tui'],
      },
    ])
  })

  test('does NOT flag a brand-new role with empty grants', () => {
    expect(diffRoles({}, { observer: { match: [], permissions: [] } })).toEqual([])
  })

  test('does NOT flag a permission removal', () => {
    const findings = diffRoles(
      { trusted: { match: [], permissions: ['channel.respond', 'security.bypass.gitExfil'] } },
      { trusted: { match: [], permissions: ['channel.respond'] } },
    )
    expect(findings).toEqual([])
  })

  test('does NOT flag a match removal', () => {
    const findings = diffRoles(
      {
        member: {
          match: [
            { kind: 'channel', platform: 'slack', workspace: 'T000', chat: 'C000' },
            { kind: 'channel', platform: 'slack', workspace: 'T000', chat: 'C111' },
          ],
        },
      },
      {
        member: { match: [{ kind: 'channel', platform: 'slack', workspace: 'T000', chat: 'C000' }] },
      },
    )
    expect(findings).toEqual([])
  })

  test('does NOT flag a reordering', () => {
    const findings = diffRoles(
      { member: { match: [{ kind: 'tui' }, { kind: 'cron' }] } },
      { member: { match: [{ kind: 'cron' }, { kind: 'tui' }] } },
    )
    expect(findings).toEqual([])
  })

  test('flags BOTH a permission gain AND a match gain on the same role', () => {
    const findings = diffRoles(
      { trusted: { match: [], permissions: ['channel.respond'] } },
      {
        trusted: {
          match: [{ kind: 'channel', platform: 'discord', author: 'U_NEW' }],
          permissions: ['channel.respond', 'cron.schedule'],
        },
      },
    )
    expect(findings.length).toBe(2)
    expect(findings.find((f) => f.kind === 'permissions-added')?.added).toEqual(['cron.schedule'])
    expect(findings.find((f) => f.kind === 'match-added')?.added).toEqual(['discord:* author:U_NEW'])
  })
})

describe('checkRolePromotionGuard — write (the canonical attack)', () => {
  test('blocks a write that promotes a chat author into owner.match', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, BEFORE_BASELINE)

    const after = {
      ...BEFORE_BASELINE,
      roles: {
        ...BEFORE_BASELINE.roles,
        owner: { match: ['tui', 'discord:* author:U_ATTACKER'] },
      },
    }
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify(after) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('owner')
    expect(result?.reason).toContain('gains match rules')
    expect(result?.reason).toContain('discord:* author:U_ATTACKER')
  })

  test('blocks a write that grants a medium-tier bypass to member', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, BEFORE_BASELINE)

    const after = {
      ...BEFORE_BASELINE,
      roles: {
        ...BEFORE_BASELINE.roles,
        member: {
          match: BEFORE_BASELINE.roles.member.match,
          permissions: ['channel.respond', 'security.bypass.medium'],
        },
      },
    }
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify(after) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('security.bypass.medium')
  })

  test('allows a write that removes a permission', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, {
      ...BEFORE_BASELINE,
      roles: {
        ...BEFORE_BASELINE.roles,
        trusted: { match: ['tui'], permissions: ['channel.respond', 'cron.schedule'] },
      },
    })

    const after = {
      ...BEFORE_BASELINE,
      roles: {
        ...BEFORE_BASELINE.roles,
        trusted: { match: ['tui'], permissions: ['channel.respond'] },
      },
    }
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify(after) },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('allows a write that does not touch the roles block', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, BEFORE_BASELINE)
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify({ ...BEFORE_BASELINE, port: 9001 }) },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('passes through when the operator acknowledges the guard', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, BEFORE_BASELINE)
    const after = {
      ...BEFORE_BASELINE,
      roles: {
        ...BEFORE_BASELINE.roles,
        owner: { match: ['tui', 'discord:* author:U_INTENT'] },
      },
    }
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: {
        path: 'typeclaw.json',
        content: JSON.stringify(after),
        [ACKNOWLEDGE_GUARDS]: { [GUARD_ROLE_PROMOTION]: true },
      },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('does not run on non-typeclaw.json paths', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: { path: 'workspace/notes.json', content: '{"roles":{"owner":{"match":["tui"]}}}' },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('does not run on non-write/edit tools', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkRolePromotionGuard({
      tool: 'read',
      args: { path: 'typeclaw.json' },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('falls through to managedConfig when the new content fails to parse', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, BEFORE_BASELINE)
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: '{ not valid json' },
      agentDir,
    })
    expect(result).toBeUndefined()
  })
})

describe('checkRolePromotionGuard — edit (oldText/newText)', () => {
  test('blocks an edit that widens owner.match', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, BEFORE_BASELINE)

    const result = await checkRolePromotionGuard({
      tool: 'edit',
      args: {
        path: 'typeclaw.json',
        edits: [
          {
            oldText: '"owner": {\n      "match": [\n        "tui"\n      ]\n    }',
            newText: '"owner": {\n      "match": [\n        "tui",\n        "discord:* author:U_NEW"\n      ]\n    }',
          },
        ],
      },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('owner')
  })

  test('allows an edit that only changes port', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, BEFORE_BASELINE)

    const result = await checkRolePromotionGuard({
      tool: 'edit',
      args: {
        path: 'typeclaw.json',
        edits: [{ oldText: '"port": 9000', newText: '"port": 9001' }],
      },
      agentDir,
    })
    expect(result).toBeUndefined()
  })
})

describe('checkRolePromotionGuard — legacy-shape on disk (migrate:true regression)', () => {
  test('legacy channels.<adapter>.allow[] on disk does not flag the migrated equivalent as a new grant', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, {
      port: 9000,
      channels: { slack: { allow: ['team:T000'] } },
    })

    const after = {
      port: 9000,
      channels: { slack: {} },
      roles: { member: { match: ['slack:T000'] } },
    }
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify(after) },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('legacy-shape file + a NEW match rule beyond the migrated baseline is still blocked', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, {
      port: 9000,
      channels: { slack: { allow: ['team:T000'] } },
    })

    const after = {
      port: 9000,
      channels: { slack: {} },
      roles: {
        member: { match: ['slack:T000'] },
        owner: { match: ['tui', 'discord:* author:U_NEW'] },
      },
    }
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify(after) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('discord:* author:U_NEW')
  })
})

describe('sanitizeForReason — operator-side ANSI injection defense', () => {
  test('strips C0 control characters (ANSI escape, BEL, etc.)', () => {
    const dirty = 'normal\u001b[2J\u001b[Hinjected\u0007text'
    expect(sanitizeForReason(dirty)).toBe('normal[2J[Hinjectedtext')
  })

  test('strips DEL (\\u007f)', () => {
    expect(sanitizeForReason('a\u007fb')).toBe('ab')
  })

  test('replaces backticks so inline-code formatting cannot be broken out of', () => {
    expect(sanitizeForReason('U_X`</code><script>')).toBe("U_X'</code><script>")
  })

  test('caps length to MAX_REASON_TOKEN_LEN', () => {
    const long = 'A'.repeat(500)
    const out = sanitizeForReason(long)
    expect(out.length).toBeLessThanOrEqual(203)
    expect(out.endsWith('...')).toBe(true)
  })

  test('passes ordinary author ids through unchanged', () => {
    expect(sanitizeForReason('U_ALICE')).toBe('U_ALICE')
    expect(sanitizeForReason('slack:T000/C001 author:U_X')).toBe('slack:T000/C001 author:U_X')
  })
})

describe('checkRolePromotionGuard — block reason is operator-safe', () => {
  test('ANSI-escape author ids are stripped before the reason reaches the operator', async () => {
    const agentDir = await makeAgentDir()
    await writeConfig(agentDir, BEFORE_BASELINE)

    const after = {
      ...BEFORE_BASELINE,
      roles: {
        ...BEFORE_BASELINE.roles,
        owner: { match: ['tui', 'discord:* author:U_NORMAL'] },
      },
    }
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify(after) },
      agentDir,
    })
    // eslint-disable-next-line no-control-regex
    expect(result?.reason).not.toMatch(/\u001b/)
  })
})

describe('checkRolePromotionGuard — first-init (no existing file)', () => {
  test('blocks a fresh write that introduces a privileged role', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: {
        path: 'typeclaw.json',
        content: JSON.stringify({
          port: 9000,
          roles: { owner: { match: ['tui', 'discord:* author:U_X'] } },
        }),
      },
      agentDir,
    })
    expect(result?.block).toBe(true)
  })

  test('allows a fresh write with only built-in roles at their default match', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkRolePromotionGuard({
      tool: 'write',
      args: {
        path: 'typeclaw.json',
        content: JSON.stringify({ port: 9000 }),
      },
      agentDir,
    })
    expect(result).toBeUndefined()
  })
})
