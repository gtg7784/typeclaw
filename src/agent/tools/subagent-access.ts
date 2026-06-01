import type { PermissionService } from '@/permissions'

import type { LiveSubagent } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'

export type SubagentAccessPermission = 'subagent.output' | 'subagent.cancel'

// Caps subagent_output/subagent_cancel to the requester's role: the caller
// must hold the permission AND resolve to a role at least as high as the
// role that spawned the subagent. Returns a denial reason string, or null
// when access is allowed. Fails closed — a missing spawn role or an
// unknown role on either side denies rather than allows.
export function denySubagentAccess(
  permissions: PermissionService | undefined,
  origin: SessionOrigin | undefined,
  live: Pick<LiveSubagent, 'spawnedByRole'>,
  permission: SubagentAccessPermission,
): string | null {
  if (permissions === undefined) return null

  if (!permissions.has(origin, permission)) {
    return `${permission} denied: insufficient permissions`
  }

  const spawnedByRole = live.spawnedByRole
  if (spawnedByRole === undefined) {
    return `${permission} denied: subagent spawn role unavailable`
  }

  const requesterRole = permissions.resolveRole(origin)
  const cmp = permissions.compareRoleSeverity(requesterRole, spawnedByRole)
  if (cmp === undefined || cmp < 0) {
    return `${permission} denied: requester role cannot access subagent spawned by higher role`
  }

  return null
}
