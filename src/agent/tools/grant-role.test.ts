import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPermissionService, type RolesConfig } from '@/permissions'

import type { SessionOrigin } from '../session-origin'
import { createGrantRoleTool } from './grant-role'

const ctx = {} as Parameters<ReturnType<typeof createGrantRoleTool>['execute']>[4]

const OWNER_DM: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: '@dm',
  chat: 'D_OWNER',
  thread: null,
  lastInboundAuthorId: 'U_OWNER',
}
const TRUSTED_DM: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: '@dm',
  chat: 'D_TRENT',
  thread: null,
  lastInboundAuthorId: 'U_TRENT',
}
const TRUSTED_GROUP: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'C_PUBLIC',
  thread: null,
  lastInboundAuthorId: 'U_TRENT',
}
const TUI: SessionOrigin = { kind: 'tui', sessionId: 's1' }

function trustedGroupWithMembership(
  membership:
    | { humans: number; bots: number; truncated: boolean; ageMs?: number; humanMemberIds?: readonly string[] }
    | undefined,
): SessionOrigin {
  return {
    kind: 'channel',
    adapter: 'slack-bot',
    workspace: 'T0123',
    chat: 'C_PUBLIC',
    thread: null,
    lastInboundAuthorId: 'U_TRENT',
    ...(membership === undefined
      ? {}
      : {
          membership: {
            humans: membership.humans,
            bots: membership.bots,
            truncated: membership.truncated,
            fetchedAt: Date.now() - (membership.ageMs ?? 0),
            ...(membership.humanMemberIds === undefined ? {} : { humanMemberIds: membership.humanMemberIds }),
          },
        }),
  }
}

const ROLES: RolesConfig = {
  owner: { match: [{ kind: 'channel', platform: 'slack', author: 'U_OWNER' }] },
  trusted: { match: [{ kind: 'channel', platform: 'slack', author: 'U_TRENT' }] },
} as unknown as RolesConfig

function freshAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-grantrole-test-'))
  writeFileSync(
    join(dir, 'typeclaw.json'),
    `${JSON.stringify({ roles: { owner: { match: ['slack:* author:U_OWNER'] }, trusted: { match: ['slack:* author:U_TRENT'] } } }, null, 2)}\n`,
  )
  return dir
}

function readRoles(dir: string): Record<string, { match?: string[]; permissions?: string[] }> {
  return (JSON.parse(readFileSync(join(dir, 'typeclaw.json'), 'utf8')) as { roles: Record<string, never> }).roles
}

function makeTool(dir: string, origin: SessionOrigin | undefined) {
  const permissions = createPermissionService({ roles: ROLES })
  return createGrantRoleTool({
    agentDir: dir,
    getOrigin: () => origin,
    permissions,
    // Mirror production: re-read roles FROM the just-written file, not a
    // static snapshot, so the test exercises the real disk-fresh contract.
    reloadRoles: () => readRolesFromDisk(dir),
  })
}

function readRolesFromDisk(dir: string): RolesConfig | undefined {
  return (JSON.parse(readFileSync(join(dir, 'typeclaw.json'), 'utf8')) as { roles?: RolesConfig }).roles
}

async function run(tool: ReturnType<typeof createGrantRoleTool>, params: Record<string, unknown>) {
  const result = await tool.execute('call_1', params as never, undefined, undefined, ctx)
  return result.details as
    | { ok: true; mode: string; role: string; value: string; added: boolean; restartRequired: boolean }
    | { ok: false; error: string }
}

describe('grant_role gate — origin', () => {
  test('group-channel origin is refused even for trusted (confused-deputy surface)', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, TRUSTED_GROUP), { role: 'member', match: 'slack:T0123 author:U_X' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain('admits any untrusted human')
    // nothing written
    expect(readRoles(dir).member).toBeUndefined()
  })

  test('undefined origin is refused', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, undefined), { role: 'member', match: 'slack:T0123 author:U_X' })
    expect(details.ok).toBe(false)
  })

  test('owner DM is allowed', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, OWNER_DM), { role: 'member', match: 'slack:T0123 author:U_WIFE' })
    expect(details.ok).toBe(true)
    expect(readRoles(dir).member?.match).toContain('slack:T0123 author:U_WIFE')
  })

  test('TUI is allowed', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, TUI), { role: 'member', match: 'slack:T0123 author:U_WIFE' })
    expect(details.ok).toBe(true)
  })
})

describe('grant_role gate — single-human group channel', () => {
  test('group channel with exactly one human member is allowed for a trusted caller', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({ humans: 1, bots: 1, truncated: false })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(true)
    expect(readRoles(dir).guest?.permissions).toContain('subagent.spawn')
  })

  test('group channel with two humans is refused even when the caller is trusted', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({ humans: 2, bots: 1, truncated: false })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain('admits any untrusted human')
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('truncated membership is refused (cannot prove the room is single-human)', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({ humans: 1, bots: 1, truncated: true })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('stale membership is refused (count may no longer hold)', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({ humans: 1, bots: 1, truncated: false, ageMs: 5 * 60 * 1000 })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('missing membership is refused (no proof of who is in the room)', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership(undefined)
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('single-human group with an untrusted caller is still refused by the caller-role check', async () => {
    const dir = freshAgentDir()
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0123',
      chat: 'C_PUBLIC',
      thread: null,
      lastInboundAuthorId: 'U_STRANGER',
      membership: { humans: 1, bots: 1, truncated: false, fetchedAt: Date.now() },
    }
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain('only owner or trusted may grant')
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })
})

describe('grant_role gate — all-humans-trusted group channel', () => {
  test('multi-human group is allowed when every human member resolves to trusted/owner', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({
      humans: 2,
      bots: 1,
      truncated: false,
      humanMemberIds: ['U_TRENT', 'U_OWNER'],
    })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(true)
    expect(readRoles(dir).guest?.permissions).toContain('subagent.spawn')
  })

  test('multi-human group is refused when any human member resolves below trusted', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({
      humans: 2,
      bots: 1,
      truncated: false,
      humanMemberIds: ['U_TRENT', 'U_STRANGER'],
    })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain('admits any untrusted human')
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('refused when humanMemberIds length disagrees with the humans count (unaccounted member)', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({
      humans: 3,
      bots: 1,
      truncated: false,
      humanMemberIds: ['U_TRENT', 'U_OWNER'],
    })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('refused when membership carries no humanMemberIds (count-only enumeration)', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({ humans: 2, bots: 1, truncated: false })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('refused when an all-trusted member list is stale', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({
      humans: 2,
      bots: 1,
      truncated: false,
      ageMs: 5 * 60 * 1000,
      humanMemberIds: ['U_TRENT', 'U_OWNER'],
    })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('refused when an all-trusted member list is truncated', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({
      humans: 2,
      bots: 1,
      truncated: true,
      humanMemberIds: ['U_TRENT', 'U_OWNER'],
    })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('refused when an all-trusted room exceeds the human-count cap', async () => {
    const dir = freshAgentDir()
    // 21 trusted humans (all resolve to trusted via a wildcard match) — over
    // the cap, so the guard refuses rather than vouch for an oversized room.
    const ids = Array.from({ length: 21 }, (_, i) => `U_TRENT_${i}`)
    const permissions = createPermissionService({
      roles: { trusted: { match: [{ kind: 'channel', platform: 'slack' }] } } as unknown as RolesConfig,
    })
    const tool = createGrantRoleTool({
      agentDir: dir,
      getOrigin: () => ({
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0123',
        chat: 'C_PUBLIC',
        thread: null,
        lastInboundAuthorId: ids[0],
        membership: { humans: ids.length, bots: 1, truncated: false, fetchedAt: Date.now(), humanMemberIds: ids },
      }),
      permissions,
      reloadRoles: () => readRolesFromDisk(dir),
    })
    const details = await run(tool, { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain('admits any untrusted human')
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })
})

describe('grant_role gate — peer bots', () => {
  test('single-human group with a peer bot present is refused', async () => {
    const dir = freshAgentDir()
    // humans===1 but bots===2 (agent + one peer bot), so a peer bot's messages
    // can still be buffered into the turn — not DM-equivalent.
    const origin = trustedGroupWithMembership({ humans: 1, bots: 2, truncated: false })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain('another bot')
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('all-trusted group with a peer bot present is refused', async () => {
    const dir = freshAgentDir()
    const origin = trustedGroupWithMembership({
      humans: 2,
      bots: 2,
      truncated: false,
      humanMemberIds: ['U_TRENT', 'U_OWNER'],
    })
    const details = await run(makeTool(dir, origin), { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('github channel is refused (collaborator membership is not a no-peer-bot proof)', async () => {
    const dir = freshAgentDir()
    const permissions = createPermissionService({
      roles: { trusted: { match: [{ kind: 'channel', platform: 'github' }] } } as unknown as RolesConfig,
    })
    const tool = createGrantRoleTool({
      agentDir: dir,
      getOrigin: () => ({
        kind: 'channel',
        adapter: 'github',
        workspace: 'acme/repo',
        chat: '1',
        thread: null,
        lastInboundAuthorId: 'U_TRENT',
        membership: { humans: 1, bots: 1, truncated: false, fetchedAt: Date.now(), humanMemberIds: ['U_TRENT'] },
      }),
      permissions,
      reloadRoles: () => readRolesFromDisk(dir),
    })
    const details = await run(tool, { role: 'guest', permission: 'subagent.spawn' })
    expect(details.ok).toBe(false)
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })
})

describe('grant_role gate — tier ceiling', () => {
  test('trusted cannot grant owner', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, TRUSTED_DM), { role: 'owner', match: 'slack:* author:U_X' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain("cannot grant the higher 'owner'")
    expect(readRoles(dir).owner?.match).not.toContain('slack:* author:U_X')
  })

  test('trusted CAN grant trusted (single-principal DM)', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, TRUSTED_DM), { role: 'trusted', match: 'slack:T0123 author:U_PEER' })
    expect(details.ok).toBe(true)
  })

  test('owner can grant trusted', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, OWNER_DM), { role: 'trusted', match: 'slack:T0123 author:U_PEER' })
    expect(details.ok).toBe(true)
  })
})

describe('grant_role — permission grants', () => {
  test('owner can open guest channel.respond (the "let community in" flow); restart-required', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, OWNER_DM), { role: 'guest', permission: 'channel.respond' })
    expect(details.ok).toBe(true)
    if (details.ok) expect(details.restartRequired).toBe(true)
    expect(readRoles(dir).guest?.permissions).toContain('channel.respond')
  })

  test('security.bypass.* is never grantable via the tool', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, OWNER_DM), { role: 'guest', permission: 'security.bypass.medium' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain('security.bypass')
    expect(readRoles(dir).guest?.permissions).toBeUndefined()
  })

  test('grant-only-what-you-hold: trusted cannot grant a permission it lacks', async () => {
    // trusted does NOT hold cron.modify (only owner does)
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, TRUSTED_DM), { role: 'member', permission: 'cron.modify' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain('does not hold')
  })

  test('trusted CAN grant a permission it holds (channel.respond)', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, TRUSTED_DM), { role: 'guest', permission: 'channel.respond' })
    expect(details.ok).toBe(true)
  })
})

describe('grant_role — argument validation', () => {
  test('requires exactly one of match or permission', async () => {
    const dir = freshAgentDir()
    const both = await run(makeTool(dir, OWNER_DM), {
      role: 'member',
      match: 'slack:T0123 author:U_X',
      permission: 'channel.respond',
    })
    expect(both.ok).toBe(false)
    const neither = await run(makeTool(dir, OWNER_DM), { role: 'member' })
    expect(neither.ok).toBe(false)
  })

  test('rejects malformed match rules', async () => {
    const dir = freshAgentDir()
    const details = await run(makeTool(dir, OWNER_DM), { role: 'member', match: 'team:T0123' })
    expect(details.ok).toBe(false)
    if (!details.ok) expect(details.error).toContain('Invalid match rule')
  })
})

describe('grant_role — hot-reload reads the post-grant state', () => {
  test('replaceRoles receives the freshly-written roles, not a stale snapshot', async () => {
    const dir = freshAgentDir()
    let replacedWith: Record<string, { match?: string[] }> | undefined
    const permissions = createPermissionService({ roles: ROLES })
    const spied: typeof permissions = {
      ...permissions,
      replaceRoles: (roles) => {
        replacedWith = roles as unknown as Record<string, { match?: string[] }> | undefined
      },
    }
    const tool = createGrantRoleTool({
      agentDir: dir,
      getOrigin: () => OWNER_DM,
      permissions: spied,
      reloadRoles: () => readRolesFromDisk(dir),
    })

    await tool.execute(
      'call_1',
      { role: 'member', match: 'slack:T0123 author:U_WIFE' } as never,
      undefined,
      undefined,
      ctx,
    )

    // the value handed to replaceRoles must reflect the grant that just landed
    // on disk — the bug was reading an in-memory snapshot taken before the write
    expect(replacedWith?.member?.match).toContain('slack:T0123 author:U_WIFE')
  })
})
