import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import {
  grantRole,
  grantRolePermission,
  isDmChannelOrigin,
  parseMatchRule,
  type PermissionService,
  type RolesConfig,
} from '@/permissions'

import type { SessionOrigin } from '../session-origin'

export type GrantRoleToolDetails =
  | { ok: true; mode: 'match' | 'permission'; role: string; value: string; added: boolean; restartRequired: boolean }
  | { ok: false; error: string }

export type CreateGrantRoleToolOptions = {
  agentDir: string
  getOrigin: () => SessionOrigin | undefined
  permissions: PermissionService
  // Live roles snapshot used to hot-reload match-grants after writing. A
  // permission-grant is restart-required, so reloading it has no runtime
  // effect, but we reload anyway so a same-session subsequent match-grant
  // sees a consistent table.
  rolesProvider: () => RolesConfig | undefined
}

// Roles this tool may target, lowest to highest. `guest` is a valid target
// (an operator opening guest channel.respond) but never a granter — the gate
// below requires the caller to resolve to owner/trusted.
const TIER_ORDER = ['guest', 'member', 'trusted', 'owner'] as const
type TierRole = (typeof TIER_ORDER)[number]

function tierOf(role: string): number {
  return TIER_ORDER.indexOf(role as TierRole)
}

function isTierRole(role: string): role is TierRole {
  return (TIER_ORDER as readonly string[]).includes(role)
}

// A single-principal turn carries only the principal's own first-party words:
// the TUI (a human typing directly) or a 1:1 DM (principal + bot, no
// third-party messages buffered in). A group/open channel turn always mixes in
// other authors' messages, which is the confused-deputy surface that lets a
// guest prompt-inject a trusted turn into rewriting the access-control table.
// Role grants are confined to single-principal turns so that surface does not
// exist.
function isSinglePrincipalOrigin(origin: SessionOrigin | undefined): boolean {
  if (origin === undefined) return false
  if (origin.kind === 'tui') return true
  if (origin.kind === 'channel') return isDmChannelOrigin(origin)
  return false
}

export function createGrantRoleTool(options: CreateGrantRoleToolOptions) {
  const { agentDir, getOrigin, permissions, rolesProvider } = options

  return defineTool({
    name: 'grant_role',
    label: 'Grant Role',
    description:
      'Assign an author to a role (match grant) or give a role a capability (permission grant), by editing typeclaw.json#roles. ' +
      'Use this to onboard a teammate ("respond to author U_X" → grant them member) or to open the agent to a wider audience ' +
      '("let anyone in this channel message you" → grant guest channel.respond). ' +
      'Only callable from the TUI or a 1:1 DM by an owner or trusted user — group-channel turns cannot use it. ' +
      'Permission grants are restart-required: they land in typeclaw.json but take effect on the next `typeclaw restart`.',
    parameters: Type.Object({
      role: Type.Union(
        [Type.Literal('owner'), Type.Literal('trusted'), Type.Literal('member'), Type.Literal('guest')],
        {
          description: 'The role to grant TO.',
        },
      ),
      match: Type.Optional(
        Type.String({
          description:
            'A match rule assigning an author/scope to the role, e.g. "slack:T0123 author:U_WIFE". ' +
            'Provide exactly one of match or permission.',
        }),
      ),
      permission: Type.Optional(
        Type.String({
          description:
            'A capability to add to the role, e.g. "channel.respond". Provide exactly one of match or permission. ' +
            'security.bypass.* permissions cannot be granted through this tool.',
        }),
      ),
    }),

    async execute(_toolCallId, params): Promise<ToolReturn> {
      const origin = getOrigin()

      if (!isSinglePrincipalOrigin(origin)) {
        return err(
          'grant_role is only available from the TUI or a 1:1 DM. A group-channel turn cannot change roles, ' +
            'because it mixes in other participants\u2019 messages (prompt-injection surface).',
        )
      }

      const callerRole = permissions.resolveRole(origin)
      if (callerRole !== 'owner' && callerRole !== 'trusted') {
        return err(`grant_role denied: caller resolves to '${callerRole}'; only owner or trusted may grant roles.`)
      }

      const hasMatch = typeof params.match === 'string' && params.match.length > 0
      const hasPermission = typeof params.permission === 'string' && params.permission.length > 0
      if (hasMatch === hasPermission) {
        return err('Provide exactly one of `match` or `permission`.')
      }

      if (!isTierRole(params.role)) {
        return err(`Unknown target role '${params.role}'.`)
      }

      // Tier ceiling: a granter may not assign or empower a role ABOVE its own.
      // owner(3) ≥ trusted(2) ≥ member(1) ≥ guest(0).
      if (tierOf(params.role) > tierOf(callerRole)) {
        return err(`grant_role denied: a ${callerRole} caller cannot grant the higher '${params.role}' role.`)
      }

      return hasMatch
        ? grantMatch(params.role, params.match as string)
        : grantPermission(callerRole, params.role, params.permission as string)
    },
  })

  function grantMatch(role: string, matchRule: string): ToolReturn {
    const parsed = parseMatchRule(matchRule)
    if (!parsed.ok) {
      return err(`Invalid match rule '${matchRule}': ${parsed.error}`)
    }

    const result = grantRole({ cwd: agentDir, roleName: role, matchRule })
    if (!result.ok) return err(result.reason)

    reload()
    return ok('match', role, matchRule, result.added, false)
  }

  function grantPermission(callerRole: string, role: string, permission: string): ToolReturn {
    // security.bypass.* defeats guards rather than enabling a feature; never
    // grantable through an agent tool. It stays a deliberate hand-edit gated by
    // the rolePromotion guard + an explicit ack.
    if (permission.startsWith('security.bypass.')) {
      return err(
        `grant_role refuses to grant '${permission}': security.bypass.* permissions disable security guards and ` +
          'must be set by hand-editing typeclaw.json (gated by the rolePromotion guard), not via this tool.',
      )
    }

    // "Grant only what you hold": the caller cannot confer a capability it does
    // not itself possess. Owner's resolved set is the expanded wildcard, so an
    // owner can grant any non-bypass core permission; trusted is capped at its
    // literal set.
    const callerPerms = permissions.describe(getOrigin()).permissions
    if (!callerPerms.includes(permission)) {
      return err(
        `grant_role denied: a ${callerRole} caller cannot grant '${permission}' because it does not hold that permission.`,
      )
    }

    const result = grantRolePermission({ cwd: agentDir, roleName: role, permission })
    if (!result.ok) return err(result.reason)

    reload()
    return ok('permission', role, permission, result.added, true)
  }

  function reload(): void {
    try {
      permissions.replaceRoles(rolesProvider())
    } catch {
      // Best-effort hot-reload of match-grants. A failure here does not undo
      // the on-disk write; the next config reload / restart picks it up.
    }
  }
}

function ok(
  mode: 'match' | 'permission',
  role: string,
  value: string,
  added: boolean,
  restartRequired: boolean,
): ToolReturn {
  const details: GrantRoleToolDetails = { ok: true, mode, role, value, added, restartRequired }
  const note = added ? '' : ' (already on file)'
  const restart = restartRequired
    ? ' This permission grant is restart-required; run `typeclaw restart` for it to take effect.'
    : ''
  const text =
    mode === 'match'
      ? `Granted role '${role}' the match rule '${value}'${note}.${restart}`
      : `Granted role '${role}' the permission '${value}'${note}.${restart}`
  return { content: [{ type: 'text', text }], details }
}

function err(message: string): ToolReturn {
  const details: GrantRoleToolDetails = { ok: false, error: message }
  return { content: [{ type: 'text', text: message }], details }
}

type ToolReturn = {
  content: { type: 'text'; text: string }[]
  details: GrantRoleToolDetails
}
