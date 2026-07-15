import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import type { PermissionService } from '@/permissions/permissions'

import { CANONICAL_AGENT_SECRET_DIRS, CANONICAL_AGENT_SECRET_FILES } from './canonical-secrets'
import { SandboxMaskTargetError } from './errors'

export type HiddenPaths = {
  dirs: string[]
  files: string[]
}

const PRIVATE_DIRS = ['workspace', 'memory', 'sessions'] as const
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
  const dirs = [
    ...(seesPrivate ? [] : PRIVATE_DIRS.map((d) => join(agentDir, d))),
    ...CANONICAL_AGENT_SECRET_DIRS.map((d) => join(agentDir, d)),
  ]
  const files = CANONICAL_AGENT_SECRET_FILES.map((f) => join(agentDir, f))
  return { dirs, files }
}

export function canWriteAgentRootInSandbox(permissions: PermissionService, origin: SessionOrigin | undefined): boolean {
  const seesPrivate =
    permissions.has(origin, CORE_PERMISSIONS.fsSeePrivate) ||
    permissions.has(origin, 'security.bypass.low') ||
    permissions.has(origin, 'security.bypass.medium')
  const seesSecrets =
    permissions.has(origin, CORE_PERMISSIONS.fsSeeSecrets) || permissions.has(origin, 'security.bypass.medium')
  return seesPrivate && seesSecrets
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
// it (last-op-wins), closing that hole for both jail modes. Required masks fail
// closed: a symlink, wrong entry kind, or materialization failure aborts bash.
export async function ensureHiddenMaskTargets(hidden: HiddenPaths): Promise<HiddenPaths> {
  const dirs = await Promise.all(hidden.dirs.map((target) => ensureMaskTarget(target, 'dir')))
  const files = await Promise.all(hidden.files.map((target) => ensureMaskTarget(target, 'file')))
  return { dirs, files }
}

async function ensureMaskTarget(target: string, kind: 'dir' | 'file'): Promise<string> {
  try {
    if (kind === 'dir') await mkdir(target, { recursive: true })
    else await ensureEmptyFile(target)
    const stats = await lstat(target)
    if (stats.isSymbolicLink()) throw new SandboxMaskTargetError(target, 'symlinks cannot be masked safely')
    const validKind = kind === 'dir' ? stats.isDirectory() : stats.isFile()
    if (!validKind) throw new SandboxMaskTargetError(target, `target is not a ${kind}`)
    return target
  } catch {
    throw new SandboxMaskTargetError(target, `could not materialize or inspect a ${kind}`)
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
