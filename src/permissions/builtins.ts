import type { MatchRule } from './match-rule'

export type BuiltinRoleName = 'owner' | 'trusted' | 'member' | 'guest'

export const BUILTIN_ROLE_NAMES: readonly BuiltinRoleName[] = ['owner', 'trusted', 'member', 'guest']

// Core-owned permission strings; not contributed by plugins. The security
// plugin's `security.bypass.*` strings are NOT listed here — they are
// collected from plugin contributions and merged into `owner`'s permission
// set at boot via expandOwnerWildcard.
export const CORE_PERMISSIONS = {
  channelRespond: 'channel.respond',
  cronSchedule: 'cron.schedule',
  cronModify: 'cron.modify',
} as const

// Sentinel that `expandOwnerWildcard` swaps for the concrete union of
// plugin-registered `security.bypass.*` strings. Users cannot write `*` in
// their own `permissions[]`; the sentinel exists only inside the built-in
// `owner` spec.
export const OWNER_SECURITY_WILDCARD = '__BUILTIN_OWNER_SECURITY_WILDCARD__'

export type BuiltinRoleSpec = {
  readonly match: readonly MatchRule[]
  readonly permissions: readonly string[]
}

export const BUILTIN_ROLES: Readonly<Record<BuiltinRoleName, BuiltinRoleSpec>> = {
  owner: {
    match: [{ kind: 'tui' }],
    permissions: [
      CORE_PERMISSIONS.channelRespond,
      CORE_PERMISSIONS.cronSchedule,
      CORE_PERMISSIONS.cronModify,
      OWNER_SECURITY_WILDCARD,
    ],
  },
  trusted: {
    match: [],
    permissions: [
      CORE_PERMISSIONS.channelRespond,
      CORE_PERMISSIONS.cronSchedule,
      'security.bypass.secretExfilBash',
      'security.bypass.gitExfil',
    ],
  },
  member: {
    match: [],
    permissions: [CORE_PERMISSIONS.channelRespond],
  },
  guest: {
    match: [],
    permissions: [],
  },
}

export function expandOwnerWildcard(
  ownerPermissions: readonly string[],
  pluginContributed: readonly string[],
): readonly string[] {
  const bypass = pluginContributed.filter((p) => p.startsWith('security.bypass.'))
  const out: string[] = []
  for (const p of ownerPermissions) {
    if (p === OWNER_SECURITY_WILDCARD) {
      for (const b of bypass) if (!out.includes(b)) out.push(b)
      continue
    }
    if (!out.includes(p)) out.push(p)
  }
  return out
}

export function isBuiltinRoleName(name: string): name is BuiltinRoleName {
  return (BUILTIN_ROLE_NAMES as readonly string[]).includes(name)
}
