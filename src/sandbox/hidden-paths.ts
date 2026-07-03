import { lstat, mkdir, writeFile } from 'node:fs/promises'
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

// SECURITY / bwrap contract: the mask ops REQUIRE a pre-existing target.
// `--ro-bind-data` (secret files) and `--tmpfs` (private dirs) create their
// mount point under the agent-folder bind, which fails "Read-only file system"
// on a virtiofs/OrbStack bind (bwrap cannot create it from its child user
// namespace). An agent whose folder legitimately lacks `.env` (keys live in
// secrets.json) would otherwise have EVERY sandboxed bash call abort at setup.
// Ensure each target on the REAL host FS first — the runtime owns agentDir RW
// here (only sandboxed bash sees it RO), so an empty placeholder is harmless and
// the mask binds over a real empty file, leaking nothing.
//
// ENSURE, not FILTER: package-install mode makes the jail root RW
// (`writableRoot: agentDir`), so dropping an absent secret would let sandboxed
// code CREATE `.env`/`secrets.json` for real (planting) or expose one created
// mid-session (TOCTOU). A guaranteed target keeps the mask always rendered over
// it (last-op-wins), closing that hole for both jail modes. A symlink squatting
// a target is refused and dropped (a bind would follow it out), and each target
// is best-effort so one bad entry degrades that mask, never aborts sandboxing.
export async function ensureHiddenMaskTargets(hidden: HiddenPaths): Promise<HiddenPaths> {
  const dirs = await ensureMaskTargets(hidden.dirs, 'dir')
  const files = await ensureMaskTargets(hidden.files, 'file')
  return { dirs, files }
}

async function ensureMaskTargets(targets: string[], kind: 'dir' | 'file'): Promise<string[]> {
  const results = await Promise.all(targets.map((target) => ensureMaskTarget(target, kind)))
  return targets.filter((_, i) => results[i])
}

async function ensureMaskTarget(target: string, kind: 'dir' | 'file'): Promise<boolean> {
  try {
    if (kind === 'dir') await mkdir(target, { recursive: true })
    else await ensureEmptyFile(target)
    return await isRealEntry(target, kind)
  } catch {
    return false
  }
}

async function ensureEmptyFile(target: string): Promise<void> {
  try {
    await writeFile(target, '', { flag: 'wx' })
  } catch {
    // Already exists or lost a creation race; isRealEntry re-validates the kind
    // and rejects a symlink, so an existing regular file passes and anything
    // else is dropped from the mask.
  }
}

async function isRealEntry(target: string, kind: 'dir' | 'file'): Promise<boolean> {
  try {
    const stats = await lstat(target)
    if (stats.isSymbolicLink()) return false
    return kind === 'dir' ? stats.isDirectory() : stats.isFile()
  } catch {
    return false
  }
}
