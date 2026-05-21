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
  subagentSpawn: 'subagent.spawn',
  subagentCancel: 'subagent.cancel',
  subagentOutput: 'subagent.output',
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

// Owner carries low + medium tier strings explicitly AND the wildcard
// sentinel. The sentinel expands to plugin-contributed `security.bypass.*`
// strings minus the security plugin's `ownerWildcardExclusions` (today:
// `security.bypass.high` plus high-tier per-guard strings). Net effect:
// owner auto-bypasses every low- and medium-tier guard, and high-tier
// guards require per-call ack from owner too (the audience-leak rule —
// owner-in-public-channel must not silently post credentials).
//
// Trusted carries only `security.bypass.low`. Trusted does NOT carry the
// pre-PR per-guard grants (`bypassSecretExfilBash`, `bypassGitExfil`):
// those guards are medium/high under the audience-leak axis and per-guard
// grants would re-introduce exactly the bypass holes the tier system
// exists to prevent. Operators who want the pre-PR ergonomics can add the
// per-guard strings explicitly to `roles.trusted.permissions[]` in
// typeclaw.json — that path stays alive forever.
export const BUILTIN_ROLES: Readonly<Record<BuiltinRoleName, BuiltinRoleSpec>> = {
  owner: {
    match: [{ kind: 'tui' }],
    permissions: [
      CORE_PERMISSIONS.channelRespond,
      CORE_PERMISSIONS.cronSchedule,
      CORE_PERMISSIONS.cronModify,
      CORE_PERMISSIONS.subagentSpawn,
      CORE_PERMISSIONS.subagentCancel,
      CORE_PERMISSIONS.subagentOutput,
      'security.bypass.low',
      'security.bypass.medium',
      OWNER_SECURITY_WILDCARD,
    ],
  },
  trusted: {
    match: [],
    permissions: [
      CORE_PERMISSIONS.channelRespond,
      CORE_PERMISSIONS.cronSchedule,
      CORE_PERMISSIONS.subagentSpawn,
      CORE_PERMISSIONS.subagentCancel,
      CORE_PERMISSIONS.subagentOutput,
      'security.bypass.low',
    ],
  },
  member: {
    match: [],
    permissions: [
      CORE_PERMISSIONS.channelRespond,
      CORE_PERMISSIONS.subagentSpawn,
      CORE_PERMISSIONS.subagentCancel,
      CORE_PERMISSIONS.subagentOutput,
    ],
  },
  guest: {
    match: [],
    permissions: [],
  },
}

// Expands the owner wildcard sentinel against plugin-contributed
// `security.bypass.*` strings. `wildcardExclusions` is an optional set of
// permission strings the sentinel must NOT expand to — used by the
// bundled security plugin to exclude `security.bypass.high` AND the
// per-guard strings for high-tier guards, so the wildcard does not
// auto-grant audience-leak bypass to owner. Explicit operator grants of
// those strings in `roles.owner.permissions[]` still take effect (they
// flow through the non-sentinel branch).
export function expandOwnerWildcard(
  ownerPermissions: readonly string[],
  pluginContributed: readonly string[],
  wildcardExclusions: readonly string[] = [],
): readonly string[] {
  const excludeSet = new Set(wildcardExclusions)
  const bypass = pluginContributed.filter((p) => p.startsWith('security.bypass.') && !excludeSet.has(p))
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
