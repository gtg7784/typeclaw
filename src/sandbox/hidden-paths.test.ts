import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { createPermissionService } from '@/permissions/permissions'
import { rolesConfigSchema, type RolesConfig } from '@/permissions/schema'

import { ensureHiddenMaskTargets, resolveHiddenPaths } from './hidden-paths'

const AGENT = '/agent'
const hiddenDirs = (agentDir: string) => [
  join(agentDir, 'workspace'),
  join(agentDir, 'memory'),
  join(agentDir, 'sessions'),
]
const secretFiles = (agentDir: string) => [join(agentDir, '.env'), join(agentDir, 'secrets.json')]

function parseRoles(raw: unknown): RolesConfig {
  const result = rolesConfigSchema.safeParse(raw)
  if (!result.success) throw new Error(`roles invalid: ${result.error.message}`)
  return result.data
}

function spawnedBy(role: string): SessionOrigin {
  return { kind: 'subagent', subagent: 'x', parentSessionId: 'p', spawnedByRole: role }
}

const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }

describe('resolveHiddenPaths — builtin tiers', () => {
  test('owner (tui) hides nothing', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, tui, AGENT)
    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })

  test('trusted hides nothing (sees private surface and secrets)', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('trusted'), AGENT)
    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })

  test('system origin hides nothing even when triggered by a guest channel turn', () => {
    const svc = createPermissionService()
    const origin: SessionOrigin = {
      kind: 'system',
      component: 'memory-logger',
      triggeredBy: { kind: 'channel', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null },
    }
    const { dirs, files } = resolveHiddenPaths(svc, origin, AGENT)
    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })

  test('member sees private surface but hides the secret files', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('member'), AGENT)
    expect(dirs).toEqual([])
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('guest hides the private surface AND the secret files', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('guest'), AGENT)
    expect(dirs).toEqual(hiddenDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('guest never hides public/ — it is the guest-visible zone', () => {
    const svc = createPermissionService()
    const { dirs } = resolveHiddenPaths(svc, spawnedBy('guest'), AGENT)
    expect(dirs).not.toContain(join(AGENT, 'public'))
  })
})

describe('resolveHiddenPaths — fail-safe', () => {
  test('undefined origin is treated as guest (everything hidden)', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, undefined, AGENT)
    expect(dirs).toEqual(hiddenDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('unmatched channel author resolves to guest (everything hidden)', () => {
    const svc = createPermissionService()
    const stranger: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
      lastInboundAuthorId: 'U_STRANGER',
    }
    const { dirs, files } = resolveHiddenPaths(svc, stranger, AGENT)
    expect(dirs).toEqual(hiddenDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })
})

describe('resolveHiddenPaths — custom roles via fs.see grants', () => {
  test('custom role with explicit fs.see.private sees the private surface', () => {
    const roles = parseRoles({ contributor: { match: ['slack:T0 author:U_C'], permissions: ['fs.see.private'] } })
    const svc = createPermissionService({ roles })
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('contributor'), AGENT)
    expect(dirs).toEqual([])
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('custom role with both fs.see grants hides nothing', () => {
    const roles = parseRoles({
      steward: { match: ['slack:T0 author:U_S'], permissions: ['fs.see.private', 'fs.see.secrets'] },
    })
    const svc = createPermissionService({ roles })
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('steward'), AGENT)
    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })
})

describe('resolveHiddenPaths — legacy security.bypass fallback', () => {
  test('a role with only bypass.low (no fs.see.*) still sees the private surface', () => {
    const roles = parseRoles({
      legacymember: { match: ['slack:T0 author:U_LM'], permissions: ['security.bypass.low'] },
    })
    const svc = createPermissionService({ roles })
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('legacymember'), AGENT)
    expect(dirs).toEqual([])
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('a role with bypass.medium (no fs.see.*) sees both private surface and secrets', () => {
    const roles = parseRoles({
      legacytrusted: { match: ['slack:T0 author:U_LT'], permissions: ['security.bypass.medium'] },
    })
    const svc = createPermissionService({ roles })
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('legacytrusted'), AGENT)
    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })
})

describe('resolveHiddenPaths — agentDir relativity', () => {
  test('masks are rooted at the given agentDir, not a hardcoded /agent', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, undefined, '/srv/app')
    expect(dirs).toEqual(hiddenDirs('/srv/app'))
    expect(files).toEqual(secretFiles('/srv/app'))
  })
})

describe('ensureHiddenMaskTargets', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tc-mask-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const isRegularFile = async (target: string) => (await lstat(target)).isFile()
  const isDir = async (target: string) => (await lstat(target)).isDirectory()

  test('materializes an absent secret file so the mask has a real target to bind over', async () => {
    // given: an agent folder whose .env legitimately does not exist (keys in secrets.json)
    const env = join(dir, '.env')
    // when
    const result = await ensureHiddenMaskTargets({ dirs: [], files: [env] })
    // then: the placeholder exists and the mask keeps it
    expect(await isRegularFile(env)).toBe(true)
    expect(result.files).toEqual([env])
  })

  test('materializes an absent private dir so a --tmpfs mask has a real mount point', async () => {
    const workspace = join(dir, 'workspace')
    const result = await ensureHiddenMaskTargets({ dirs: [workspace], files: [] })
    expect(await isDir(workspace)).toBe(true)
    expect(result.dirs).toEqual([workspace])
  })

  test('leaves an existing secret file untouched and keeps it in the mask', async () => {
    const secrets = join(dir, 'secrets.json')
    await writeFile(secrets, '{"real":"content"}')
    const result = await ensureHiddenMaskTargets({ dirs: [], files: [secrets] })
    expect(result.files).toEqual([secrets])
    expect(await Bun.file(secrets).text()).toBe('{"real":"content"}')
  })

  test('drops a symlinked mask target — a bind would follow it outside the jail', async () => {
    // given: a symlink squatting the .env mask target
    const outside = join(dir, 'outside')
    await writeFile(outside, 'secret')
    const env = join(dir, '.env')
    await symlink(outside, env)
    // when
    const result = await ensureHiddenMaskTargets({ dirs: [], files: [env] })
    // then: the symlink is refused, so it never becomes a --ro-bind-data target
    expect(result.files).toEqual([])
  })

  test('degrades per target: one unmaterializable entry drops out, the rest survive', async () => {
    // given: .env is a symlink (dropped), secrets.json is absent (created)
    const badEnv = join(dir, '.env')
    await symlink(join(dir, 'nowhere'), badEnv)
    const secrets = join(dir, 'secrets.json')
    // when
    const result = await ensureHiddenMaskTargets({ dirs: [], files: [badEnv, secrets] })
    // then
    expect(result.files).toEqual([secrets])
    expect(await isRegularFile(secrets)).toBe(true)
  })
})
