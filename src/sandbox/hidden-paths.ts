import { join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import type { PermissionService } from '@/permissions/permissions'

export type HiddenPaths = {
  dirs: string[]
  files: string[]
}

const PRIVATE_DIRS = ['workspace', 'memory', 'sessions'] as const
const SECRET_FILES = ['.env', 'secrets.json'] as const

// The agent's private working surface and credential files are masked from
// sandboxed bash unless the resolved role carries the matching fs.see.* grant.
// `permissions.has` resolves the role from the live origin and fails safe to
// guest (empty permissions) for an unclear/undefined origin, so a missing
// grant — whether from a low tier or an unresolvable author — hides the path.
//
// The security.bypass.* fallback keeps custom roles (which may never name the
// fs.see.* strings) working by capability: a role trusted enough to bypass
// medium-severity guards is treated as trusted for filesystem visibility, and
// bypass.low maps to the private-surface tier. fs.see.* always wins when
// present; the fallback only fires when it is absent.
export function resolveHiddenPaths(
  permissions: PermissionService,
  origin: SessionOrigin | undefined,
  agentDir: string,
): HiddenPaths {
  const seesPrivate =
    permissions.has(origin, CORE_PERMISSIONS.fsSeePrivate) ||
    permissions.has(origin, 'security.bypass.low') ||
    permissions.has(origin, 'security.bypass.medium')
  const seesSecrets =
    permissions.has(origin, CORE_PERMISSIONS.fsSeeSecrets) || permissions.has(origin, 'security.bypass.medium')

  const dirs = seesPrivate ? [] : PRIVATE_DIRS.map((d) => join(agentDir, d))
  const files = seesSecrets ? [] : SECRET_FILES.map((f) => join(agentDir, f))
  return { dirs, files }
}
