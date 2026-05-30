import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPermissionService, type RolesConfig } from '@/permissions'

import { __resetConfigForTesting, reloadConfig } from './config'
import { createConfigReloadable } from './reloadable'

afterEach(() => {
  __resetConfigForTesting()
})

function freshAgentDir(initial: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-reload-roles-'))
  writeFileSync(join(dir, 'typeclaw.json'), `${JSON.stringify(initial, null, 2)}\n`)
  return dir
}

describe('config reload: roles split between match (applied) and permissions (restart-required)', () => {
  test('changing only roles.<name>.match → reported as applied and permissions.replaceRoles is called', async () => {
    const cwd = freshAgentDir({
      model: 'openai/gpt-5.4-mini',
      roles: { owner: { match: ['tui'] } },
    })
    reloadConfig(cwd)

    const initialRoles: RolesConfig = { owner: { match: [{ kind: 'tui' }] } }
    const permissions = createPermissionService({ roles: initialRoles })
    expect(permissions.has({ kind: 'tui', sessionId: 's1' }, 'channel.respond')).toBe(true)
    expect(
      permissions.has(
        {
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T0123',
          chat: 'C0',
          thread: null,
          lastInboundAuthorId: 'U_ME',
        },
        'channel.respond',
      ),
    ).toBe(false)

    writeFileSync(
      join(cwd, 'typeclaw.json'),
      `${JSON.stringify(
        {
          model: 'openai/gpt-5.4-mini',
          roles: { owner: { match: ['tui', 'slack:T0123 author:U_ME'] } },
        },
        null,
        2,
      )}\n`,
    )

    const reloadable = createConfigReloadable({ cwd, permissions })
    const result = await reloadable.reload()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.details).toBeDefined()
    const details = result.details as { applied: { path: string }[]; restartRequired: { path: string }[] }
    expect(details.applied.map((c) => c.path)).toContain('roles.match')
    expect(details.restartRequired.map((c) => c.path)).not.toContain('roles.permissions')

    expect(
      permissions.has(
        {
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T0123',
          chat: 'C0',
          thread: null,
          lastInboundAuthorId: 'U_ME',
        },
        'channel.respond',
      ),
    ).toBe(true)
  })

  test('roles.<name>.match change → onRolesChanged fired so live channel sessions are recreated', async () => {
    const cwd = freshAgentDir({
      model: 'openai/gpt-5.4-mini',
      roles: { owner: { match: ['tui'] } },
    })
    reloadConfig(cwd)

    const permissions = createPermissionService({ roles: { owner: { match: [{ kind: 'tui' }] } } })
    let recreated = 0

    writeFileSync(
      join(cwd, 'typeclaw.json'),
      `${JSON.stringify(
        { model: 'openai/gpt-5.4-mini', roles: { owner: { match: ['tui', 'slack:T0123 author:U_ME'] } } },
        null,
        2,
      )}\n`,
    )

    const reloadable = createConfigReloadable({
      cwd,
      permissions,
      onRolesChanged: () => {
        recreated++
      },
    })
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    expect(recreated).toBe(1)
  })

  test('reload with no role.match change → onRolesChanged not fired', async () => {
    const cwd = freshAgentDir({ model: 'openai/gpt-5.4-mini', roles: { owner: { match: ['tui'] } } })
    reloadConfig(cwd)

    let recreated = 0
    const reloadable = createConfigReloadable({
      cwd,
      onRolesChanged: () => {
        recreated++
      },
    })
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    expect(recreated).toBe(0)
  })

  test('changing roles.<name>.permissions → reported as restart-required', async () => {
    const cwd = freshAgentDir({
      model: 'openai/gpt-5.4-mini',
      roles: { member: { match: ['slack:T0123'], permissions: ['channel.respond'] } },
    })
    reloadConfig(cwd)

    writeFileSync(
      join(cwd, 'typeclaw.json'),
      `${JSON.stringify(
        {
          model: 'openai/gpt-5.4-mini',
          roles: {
            member: {
              match: ['slack:T0123'],
              permissions: ['channel.respond', 'cron.schedule'],
            },
          },
        },
        null,
        2,
      )}\n`,
    )

    const reloadable = createConfigReloadable({ cwd })
    const result = await reloadable.reload()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const details = result.details as { applied: { path: string }[]; restartRequired: { path: string }[] }
    expect(details.restartRequired.map((c) => c.path)).toContain('roles.permissions')
    expect(details.applied.map((c) => c.path)).not.toContain('roles.permissions')
  })
})
