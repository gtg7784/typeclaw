import type { PermissionService } from '@/permissions'

import type { LiveSubagent, LiveSubagentRegistry } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'

export type SubagentAccessPermission = 'subagent.output' | 'subagent.cancel'

export type SubagentAccessResult = { ok: true; live: LiveSubagent } | { ok: false; message: string }

export type AuthorizeLiveSubagentAccessArgs = {
  permissions: PermissionService | undefined
  origin: SessionOrigin | undefined
  liveRegistry: LiveSubagentRegistry
  taskId: string
  permission: SubagentAccessPermission
}

// Authorizes a single subagent_output/subagent_cancel call and resolves the
// live entry in one place so the two tools cannot drift. Caps access to the
// requester's role: the caller must hold the permission AND resolve to a role
// at least as high as the role that spawned the subagent.
//
// The ordering closes an existence oracle: the task-independent base-permission
// check runs BEFORE any registry lookup, and for non-owner callers an absent
// task, a capped task, and a task with missing provenance all collapse to one
// identical denial — so a lower-role caller cannot probe which task IDs are
// live. Only `owner` (the trust root, which outranks every spawner) learns the
// truthful `Unknown task_id` for a genuine miss. The cap fails closed.
export function authorizeLiveSubagentAccess(args: AuthorizeLiveSubagentAccessArgs): SubagentAccessResult {
  const { permissions, origin, liveRegistry, taskId, permission } = args

  if (permissions === undefined) {
    const live = liveRegistry.get(taskId)
    if (live === undefined) {
      return { ok: false, message: `Unknown task_id: ${taskId}.` }
    }
    return { ok: true, live }
  }

  if (!permissions.has(origin, permission)) {
    return { ok: false, message: `${permission} denied: insufficient permissions` }
  }

  const requesterRole = permissions.resolveRole(origin)
  const accessAll = requesterRole === 'owner'
  const opaqueDenial = `${permission} denied: unknown task_id or insufficient role`

  const live = liveRegistry.get(taskId)
  if (live === undefined) {
    return { ok: false, message: accessAll ? `Unknown task_id: ${taskId}.` : opaqueDenial }
  }
  if (accessAll) {
    return { ok: true, live }
  }

  const spawnedByRole = live.spawnedByRole
  if (spawnedByRole === undefined) {
    return { ok: false, message: opaqueDenial }
  }

  const cmp = permissions.compareRoleSeverity(requesterRole, spawnedByRole)
  if (cmp === undefined || cmp < 0) {
    return { ok: false, message: opaqueDenial }
  }

  return { ok: true, live }
}
