import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path, { isAbsolute, join, resolve } from 'node:path'

export type WritableZones = {
  dirs: string[]
  files: string[]
}

export type ProtectedZones = {
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
// `.git` is writable so a member can `git add`/`git commit` their own edits.
// This is the AGENT'S OWN repo, not a shared/upstream one, so writing history
// is not a privilege boundary: a low-trust role staging a tracked path it
// cannot edit in the worktree (e.g. via `git update-index --cacheinfo` plumbing)
// only writes the agent's own history — content the backup runner already
// force-commits on idle regardless. So we deliberately do NOT try to confine
// commit *content* to the worktree write-allowlist; that boundary governs the
// working tree, not the object database.
//
// The one thing writable `.git` must NOT grant is code execution in the
// UNSANDBOXED runtime (backup/dreaming commit the same .git out of band): a
// planted `.git/hooks/*` or a `core.hooksPath` in `.git/config` would fire there
// as a higher-privilege process. resolveProtectedZones re-binds `.git/hooks` and
// `.git/config` read-only (after the writable .git bind, last-op-wins) to close
// exactly that escalation.
const WRITABLE_DIRS = ['workspace', 'public', 'mounts', '.git'] as const

// SECURITY: configured writable paths (`sandbox.writablePaths`) may NOT resolve
// onto these. `.git` carries the hook/config escalation surface; `.env` and
// `secrets.json` are the credential files; `sessions`/`memory` are the agent's
// private surface (masked from low-trust roles by hidden-paths); `.typeclaw`
// holds system-managed home persistence; `node_modules` is executable
// dependency code. Granting blanket RW to any of these via config would defeat
// the very guards the narrow built-in set exists to preserve. The agent root
// itself is also rejected (a writablePaths of '' or '.') — an RW bind of the
// whole tree erases the read-only confinement wholesale.
const FORBIDDEN_WRITABLE_ROOTS = [
  '.git',
  '.env',
  'secrets.json',
  'sessions',
  'memory',
  '.typeclaw',
  'node_modules',
] as const

const PROTECTED_GIT_DIRS = ['.git/hooks'] as const
const PROTECTED_GIT_FILES = ['.git/config'] as const

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
//
// `configuredWritablePaths` are operator-chosen agent-relative dirs from
// `sandbox.writablePaths`. They join the built-in dirs through the SAME
// existence + symlink filter, plus the extra guardrails in
// `resolveConfiguredWritableDirs`: each must resolve inside agentDir and must
// not land on a forbidden root. A path that fails any check is dropped, never
// throws — a stale config should degrade the one bad entry, not abort sandboxing.
export async function resolveWritableZones(
  agentDir: string,
  configuredWritablePaths: readonly string[] = [],
): Promise<WritableZones> {
  const builtinDirs = await collectExisting(
    WRITABLE_DIRS.map((d) => join(agentDir, d)),
    'dir',
  )
  const configuredDirs = await resolveConfiguredWritableDirs(agentDir, configuredWritablePaths)
  const files = await collectExisting(
    WRITABLE_ROOT_FILES.map((f) => join(agentDir, f)),
    'file',
  )
  return { dirs: dedupe([...builtinDirs, ...configuredDirs]), files }
}

async function resolveConfiguredWritableDirs(agentDir: string, configured: readonly string[]): Promise<string[]> {
  const candidates: string[] = []
  for (const rel of configured) {
    const absolute = resolve(agentDir, rel)
    if (!isAllowedConfiguredTarget(agentDir, absolute)) continue
    candidates.push(absolute)
  }
  return collectExisting(candidates, 'dir')
}

function isAllowedConfiguredTarget(agentDir: string, absolute: string): boolean {
  if (absolute === agentDir || !isInside(agentDir, absolute)) return false
  return !FORBIDDEN_WRITABLE_ROOTS.some((root) => {
    const forbidden = join(agentDir, root)
    return absolute === forbidden || isInside(forbidden, absolute)
  })
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

// Read-only re-protections rendered on top of the writable .git bind. Unlike
// the writable resolvers, this MUST NOT drop absent entries: .git is writable,
// so a path absent at jail-build time would otherwise be CREATED by sandboxed
// bash (e.g. a planted .git/hooks/pre-commit) and then executed by the
// unsandboxed runtime git ops. So we ensure each protected path exists first,
// then always RO-bind it — a read-only bind of a real dir blocks creating
// children inside it (EROFS), and a read-only bind of config keeps its real
// content readable (commits need user.name/email) while blocking mutation.
//
// We also resolve the effective core.hooksPath from the real (about-to-be-RO)
// config: if it already points at a writable location (e.g. workspace/hooks),
// the .git/hooks RO-bind alone would not cover it, so that dir is protected too.
export async function resolveProtectedZones(agentDir: string): Promise<ProtectedZones> {
  const dirs: string[] = []
  for (const rel of PROTECTED_GIT_DIRS) {
    dirs.push(await ensureProtectedDir(join(agentDir, rel)))
  }
  const files: string[] = []
  for (const rel of PROTECTED_GIT_FILES) {
    files.push(await ensureProtectedFile(join(agentDir, rel)))
  }

  const hooksPathDir = await resolveEffectiveHooksPath(agentDir)
  if (hooksPathDir !== undefined && !dirs.includes(hooksPathDir)) {
    dirs.push(await ensureProtectedDir(hooksPathDir))
  }

  return { dirs, files }
}

// Fail closed: a symlink at a protected path would make the RO bind follow it
// elsewhere, so reject it rather than silently protect the wrong target.
async function ensureProtectedDir(target: string): Promise<string> {
  await mkdir(target, { recursive: true })
  await assertNotSymlink(target)
  return target
}

async function ensureProtectedFile(target: string): Promise<string> {
  if (!(await isRealEntry(target, 'file'))) {
    try {
      await writeFile(target, '', { flag: 'wx' })
    } catch {
      // Lost a race (or it appeared); the symlink check below still guards it.
    }
  }
  await assertNotSymlink(target)
  return target
}

async function assertNotSymlink(target: string): Promise<void> {
  const stats = await lstat(target)
  if (stats.isSymbolicLink()) {
    throw new Error(`sandbox: refusing to protect symlinked path ${target}`)
  }
}

// Reads core.hooksPath straight from .git/config text (the file is about to be
// RO-bound, so its content is the trusted baseline). Returns the resolved
// absolute dir only when it lands inside agentDir — an outside path is not
// writable by the jail and a relative path resolves against the repo root, per
// gitconfig semantics.
async function resolveEffectiveHooksPath(agentDir: string): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(join(agentDir, '.git', 'config'), 'utf8')
  } catch {
    return undefined
  }
  const match = text.match(/^\s*hooksPath\s*=\s*(.+?)\s*$/m)
  if (match === null) return undefined
  const raw = match[1]?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(agentDir, raw)
  return isInside(agentDir, resolved) ? resolved : undefined
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
