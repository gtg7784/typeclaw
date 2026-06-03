import { lstat } from 'node:fs/promises'
import path, { join } from 'node:path'

export type WritableZones = {
  dirs: string[]
  files: string[]
}

// SECURITY: a blanket RW bind is coarser than the write/edit guards, so this set
// is deliberately NARROWER than the write/edit allowlist — only genuinely
// free-write scratch zones. `.agents/skills` and `packages` are excluded: the
// former is validated (SKILL.md shape, name, frontmatter) by the skillAuthoring
// guard and the latter holds executable plugin code; bash must not get blanket
// RW to either. Skill authoring and package writes go through the guarded
// write/edit tool only.
const WRITABLE_DIRS = ['workspace', 'public', 'mounts'] as const

// Bash may EDIT these when present; creating a MISSING root file goes through
// write/edit (bwrap cannot RW-bind a non-existent source without pre-creating it).
const WRITABLE_ROOT_FILES = [
  'AGENTS.md',
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'cron.json',
  'package.json',
  'typeclaw.json',
] as const

// SECURITY: the symlink rejection is load-bearing. An RW bind follows symlinks,
// so a `workspace -> /etc` symlink at a zone root would grant write access to an
// outside path. (Symlinks INSIDE a real zone are already safe — the kernel
// resolves them to the read-only parent mount.)
export async function resolveWritableZones(agentDir: string): Promise<WritableZones> {
  const dirs = await collectExisting(
    WRITABLE_DIRS.map((d) => join(agentDir, d)),
    'dir',
  )
  const files = await collectExisting(
    WRITABLE_ROOT_FILES.map((f) => join(agentDir, f)),
    'file',
  )
  return { dirs, files }
}

// SECURITY: a writable RW bind renders AFTER the masks and last-op-wins, so an
// RW bind on a masked path would re-expose the real (hidden) directory. Drop any
// writable zone that is, or is nested under, a masked path so the confidentiality
// boundary survives — e.g. a guest's masked `workspace/` is never re-exposed RW.
export function subtractMasked(writable: WritableZones, masked: { dirs: string[]; files: string[] }): WritableZones {
  const maskedDirs = masked.dirs
  const isMasked = (target: string): boolean =>
    masked.files.includes(target) || maskedDirs.some((dir) => target === dir || isInside(dir, target))
  return {
    dirs: writable.dirs.filter((dir) => !isMasked(dir)),
    files: writable.files.filter((file) => !isMasked(file)),
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function collectExisting(paths: string[], kind: 'dir' | 'file'): Promise<string[]> {
  const checks = await Promise.all(paths.map((p) => isRealEntry(p, kind)))
  return paths.filter((_, i) => checks[i])
}

async function isRealEntry(path: string, kind: 'dir' | 'file'): Promise<boolean> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) return false
    return kind === 'dir' ? stats.isDirectory() : stats.isFile()
  } catch {
    return false
  }
}
