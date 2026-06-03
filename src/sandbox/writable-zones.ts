import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

export type WritableZones = {
  dirs: string[]
  files: string[]
}

// SECURITY: must mirror the write/edit guard allowlist in
// src/bundled-plugins/guard/policies/non-workspace-write.ts — any divergence
// lets bash write where the write/edit tool cannot, or vice versa. Subagent-only
// memory paths are deliberately excluded (memory/ is masked from low-trust bash).
const WRITABLE_DIRS = ['workspace', 'public', 'mounts', 'packages', '.agents/skills'] as const

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
