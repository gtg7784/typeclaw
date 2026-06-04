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
  // The caller's own session id. When the caller is itself a subagent, access
  // is scoped to subagents IT spawned (live.parentSessionId === callerSessionId)
  // so a nested subagent cannot read or cancel siblings or parent-branch runs.
  // Omitted by main-session callers, which keep the role-severity cap only.
  callerSessionId?: string
}

// Authorizes a single subagent_output/subagent_cancel call and resolves the
// live entry in one place so the two tools cannot drift. Two authorization
// modes, both requiring the base permission first:
//   - SUBAGENT caller: scoped to runs it spawned (live.parentSessionId ===
//     callerSessionId). Ownership is the authorization; the role cap is skipped.
//   - MAIN-SESSION caller: capped to the requester's role — must resolve to a
//     role at least as high as the role that spawned the subagent.
//
// The ordering closes an existence oracle: the task-independent base-permission
// check runs BEFORE any registry lookup, and for non-owner callers an absent
// task, a capped task, and a task with missing provenance all collapse to one
// identical denial — so a lower-role caller cannot probe which task IDs are
// live. Only `owner` (the trust root, which outranks every spawner) learns the
// truthful `Unknown task_id` for a genuine miss. Both modes fail closed.
export function authorizeLiveSubagentAccess(args: AuthorizeLiveSubagentAccessArgs): SubagentAccessResult {
  const { permissions, origin, liveRegistry, taskId, permission, callerSessionId } = args

  // A subagent caller may only touch subagents it spawned itself — never a
  // sibling's or its parent's run. For subagent callers this ownership check
  // REPLACES the role-severity cap (see the ownershipScoped branch below);
  // main-session callers (subagent origin absent) skip it and fall through to
  // the role cap, preserving the operator's global visibility over every spawn.
  const ownershipScoped = origin?.kind === 'subagent'
  const opaqueOwnershipDenial = `${permission} denied: unknown task_id or not owned by caller`

  if (permissions === undefined) {
    const live = liveRegistry.get(taskId)
    if (live === undefined) {
      return { ok: false, message: `Unknown task_id: ${taskId}.` }
    }
    if (ownershipScoped && live.parentSessionId !== callerSessionId) {
      return { ok: false, message: opaqueOwnershipDenial }
    }
    return { ok: true, live }
  }

  if (!permissions.has(origin, permission)) {
    return { ok: false, message: `${permission} denied: insufficient permissions` }
  }

  const requesterRole = permissions.resolveRole(origin)
  const accessAll = requesterRole === 'owner'

  // For a subagent caller, ownership of the run IS the authorization: having
  // passed the base permission check above, it may manage exactly the children
  // it spawned. The role-severity cap (below) does NOT apply — a deep subagent
  // that inherited a low role from, say, a guest channel turn must still be
  // able to read/cancel its own children; the cap is meant to stop a low-role
  // MAIN session from reaching a higher-role-spawned run, which ownership
  // already prevents here. A non-owning subagent caller fails closed.
  if (ownershipScoped) {
    const live = liveRegistry.get(taskId)
    if (live === undefined || live.parentSessionId !== callerSessionId) {
      return { ok: false, message: opaqueOwnershipDenial }
    }
    return { ok: true, live }
  }

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
