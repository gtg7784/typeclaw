import type { SessionOrigin } from '@/agent/session-origin'

import { BUILTIN_ROLE_NAMES, BUILTIN_ROLES, CORE_PERMISSIONS, expandOwnerWildcard, isBuiltinRoleName } from './builtins'
import type { MatchRule } from './match-rule'
import { matchesOrigin } from './resolve'
import type { RoleConfig, RolesConfig } from './schema'

export type PermissionService = {
  has(origin: SessionOrigin | undefined, permission: string): boolean
  resolveRole(origin: SessionOrigin | undefined): string
  describe(origin: SessionOrigin | undefined): { role: string; permissions: readonly string[] }
}

export type UnknownPermissionWarning = {
  role: string
  permission: string
  hint: string
}

export const noopPermissionService: PermissionService = {
  has: () => false,
  resolveRole: () => 'guest',
  describe: () => ({ role: 'guest', permissions: [] }),
}

type ResolvedRole = {
  name: string
  match: readonly MatchRule[]
  permissions: readonly string[]
}

export type CreatePermissionServiceOptions = {
  roles?: RolesConfig
  pluginPermissions?: readonly string[]
}

// Returns warnings for user-declared `permissions[]` strings that aren't
// in the known universe (core permissions ∪ plugin-declared). Non-fatal;
// the runtime still resolves the role with the unknown string in its
// permission list -- `has()` checks for that exact string and would return
// true if someone happened to check for it. The warning surfaces typos
// like `security.bypass.secretExfilBach` before they silently fail to
// gate the corresponding guard.
export function findUnknownPermissions(
  roles: RolesConfig | undefined,
  pluginPermissions: readonly string[],
): UnknownPermissionWarning[] {
  if (!roles) return []
  const known = new Set<string>([...Object.values(CORE_PERMISSIONS), ...pluginPermissions])
  const out: UnknownPermissionWarning[] = []
  for (const [role, config] of Object.entries(roles)) {
    if (config.permissions === undefined) continue
    for (const perm of config.permissions) {
      if (!known.has(perm)) {
        out.push({ role, permission: perm, hint: closestPermission(perm, known) })
      }
    }
  }
  return out
}

function closestPermission(target: string, known: ReadonlySet<string>): string {
  let best: { name: string; distance: number } | null = null
  for (const name of known) {
    const d = levenshtein(target, name)
    if (best === null || d < best.distance) best = { name, distance: d }
  }
  if (best === null || best.distance > Math.max(3, Math.floor(target.length * 0.25))) {
    return 'no close match in known permissions; check spelling'
  }
  return `did you mean '${best.name}'?`
}

function levenshtein(a: string, b: string): number {
  const la = a.length
  const lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la
  const prev = new Array<number>(lb + 1)
  const curr = new Array<number>(lb + 1)
  for (let j = 0; j <= lb; j++) prev[j] = j
  for (let i = 1; i <= la; i++) {
    curr[0] = i
    for (let j = 1; j <= lb; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    for (let j = 0; j <= lb; j++) prev[j] = curr[j]!
  }
  return prev[lb]!
}

export function createPermissionService(opts: CreatePermissionServiceOptions = {}): PermissionService {
  const resolved = buildRoleTable(opts.roles ?? {}, opts.pluginPermissions ?? [])
  const byName = new Map(resolved.map((r) => [r.name, r]))

  function resolveRole(origin: SessionOrigin | undefined): string {
    if (origin === undefined) return 'guest'

    if (origin.kind === 'cron') {
      const role = origin.scheduledByRole
      if (role !== undefined && byName.has(role)) return role
      return 'guest'
    }
    if (origin.kind === 'subagent') {
      const role = origin.spawnedByRole
      if (role !== undefined && byName.has(role)) return role
      return 'guest'
    }

    const matchable = toMatchable(origin)
    if (matchable === null) return 'guest'

    for (const role of resolved) {
      for (const rule of role.match) {
        if (matchesOrigin(rule, matchable)) return role.name
      }
    }
    return 'guest'
  }

  return {
    has(origin, permission) {
      const roleName = resolveRole(origin)
      const role = byName.get(roleName)
      if (!role) return false
      return role.permissions.includes(permission)
    },
    resolveRole,
    describe(origin) {
      const name = resolveRole(origin)
      const role = byName.get(name)
      return { role: name, permissions: role?.permissions ?? [] }
    },
  }
}

function buildRoleTable(roles: RolesConfig, pluginPermissions: readonly string[]): ResolvedRole[] {
  const out: ResolvedRole[] = []
  const seen = new Set<string>()

  for (const name of Object.keys(roles)) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(resolveOne(name, roles[name], pluginPermissions))
  }

  for (const name of BUILTIN_ROLE_NAMES) {
    if (seen.has(name)) continue
    out.push(resolveOne(name, undefined, pluginPermissions))
  }

  return out
}

function resolveOne(name: string, user: RoleConfig | undefined, pluginPermissions: readonly string[]): ResolvedRole {
  if (isBuiltinRoleName(name)) {
    const builtin = BUILTIN_ROLES[name]
    const match = [...builtin.match, ...(user?.match ?? [])]
    const rawPerms = user?.permissions !== undefined ? user.permissions : [...builtin.permissions]
    const permissions = name === 'owner' ? expandOwnerWildcard(rawPerms, pluginPermissions) : rawPerms
    return { name, match, permissions }
  }
  return {
    name,
    match: user?.match ?? [],
    permissions: user?.permissions ?? [],
  }
}

function toMatchable(origin: SessionOrigin): Parameters<typeof matchesOrigin>[1] | null {
  switch (origin.kind) {
    case 'tui':
      return { kind: 'tui', sessionId: origin.sessionId }
    case 'channel':
      return {
        kind: 'channel',
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        ...(origin.lastInboundAuthorId !== undefined ? { lastInboundAuthorId: origin.lastInboundAuthorId } : {}),
      }
    default:
      return null
  }
}
