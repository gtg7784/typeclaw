import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
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
//
// SECURITY: the semantically-guarded managed files (`cron.json`, `typeclaw.json`)
// are deliberately EXCLUDED. Those two are the only files gated by the
// managedConfig / cronPromotion guards, which fire on the `write`/`edit` tools
// only. Granting bash a blanket RW bind to them opened a bypass: an agent
// blocked from writing cron.json through the guarded tools could just
// `echo … > cron.json` from bash and defeat the guard entirely. Keeping them off
// this list forces every mutation of a guarded file through the one guarded path
// (the write/edit tool), so a managed file has exactly one mutation boundary.
// `package.json` stays writable: it is NOT a semantically-guarded managed file
// (only cron.json/typeclaw.json are), and `bun add`/manual dep edits legitimately
// touch it from bash.
const WRITABLE_ROOT_FILES = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'package.json'] as const

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

// SECURITY: validation is on the REAL path, not the lexical one. A lexical-only
// check (resolve + isInside) is bypassable by a symlinked INTERMEDIATE component:
// with `/agent/alias -> /tmp/outside` (or `-> /agent/sessions`) and a config of
// `alias/sub`, the lexical path `/agent/alias/sub` passes isInside and the
// forbidden-root check, while the bwrap `--bind` follows the ancestor symlink to
// write outside /agent (or onto a forbidden root). The zone-root lstat alone
// can't see it — lstat of the final component follows ancestor symlinks. So we
// realpath BOTH the candidate and agentDir (+ the forbidden roots) and validate
// the resolved targets. A path whose real form escapes agentDir or lands on a
// real forbidden root is dropped. realpath also rejects the final component
// being a symlink (its real target is re-checked), subsuming the prior lstat.
async function resolveConfiguredWritableDirs(agentDir: string, configured: readonly string[]): Promise<string[]> {
  const realAgentDir = await realpathOrUndefined(agentDir)
  if (realAgentDir === undefined) return []
  const realForbidden = await resolveRealForbiddenRoots(agentDir)

  const accepted: string[] = []
  for (const rel of configured) {
    const absolute = resolve(agentDir, rel)
    // Cheap lexical pre-filter: reject obvious escapes before touching the disk.
    if (absolute === agentDir || !isInside(agentDir, absolute)) continue
    const real = await realpathOrUndefined(absolute)
    if (real === undefined) continue
    if (!(await isRealEntry(real, 'dir'))) continue
    if (real === realAgentDir || !isInside(realAgentDir, real)) continue
    if (realForbidden.some((root) => real === root || isInside(root, real))) continue
    // Bind the lexical (caller-facing) path; bwrap resolves it to `real` itself.
    accepted.push(absolute)
  }
  return accepted
}

async function resolveRealForbiddenRoots(agentDir: string): Promise<string[]> {
  const resolved: string[] = []
  for (const root of FORBIDDEN_WRITABLE_ROOTS) {
    const real = await realpathOrUndefined(join(agentDir, root))
    if (real !== undefined) resolved.push(real)
  }
  return resolved
}

async function realpathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await realpath(target)
  } catch {
    return undefined
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

export type PackageInstallZones = {
  root: string
  protected: ProtectedZones
  // Guarded managed files that are ABSENT at jail-build time. The RW package-
  // install root would otherwise let a `bun install` postinstall lifecycle
  // script CREATE them (a guard bypass — see the SECURITY note on
  // MANAGED_ROOT_FILES). Rendered as `--ro-bind /dev/null <path>` so the path is
  // occupied by an empty read-only object that blocks creation, without
  // manufacturing a real (invalid) file on the host FS the way the secret-mask
  // placeholder pattern would. Present managed files go in `protected.files`.
  blockedCreation: string[]
}

// SECURITY: the semantically-guarded managed files. They are gated by the
// managedConfig / cronPromotion guards (write/edit tools only), so bash must
// never be able to write OR create them. The normal jail already excludes them
// from WRITABLE_ROOT_FILES; the package-install RW root needs the extra step of
// blocking their CREATION when absent (see PackageInstallZones.blockedCreation).
const MANAGED_ROOT_FILES = ['cron.json', 'typeclaw.json'] as const

// SECURITY: the package-install RW root is governed by an ALLOWLIST, not a
// denylist. `bun add` writes exactly these and nothing else: `node_modules/`
// (deps), `package.json` + `bun.lock` (manifest + lockfile, plus the temp
// lockfile created in the root DIR). The scratch zones (`workspace`, `public`,
// `mounts`) stay writable to match the normal jail. EVERY other existing root
// entry is RO-bound, so a denylist of "executable/runtime-sensitive" paths is
// not needed — it would be unbounded (any file the unsandboxed runtime reads or
// execs, including `src/`/`scripts/` in dev-mode agents where typeclaw is a
// file:/link: dep, the agent's own lifecycle scripts, and prompt-source files)
// and fails OPEN for any root entry not yet listed. An allowlist fails CLOSED.
const PACKAGE_INSTALL_WRITABLE_DIRS = ['node_modules', 'workspace', 'public', 'mounts'] as const
const PACKAGE_INSTALL_WRITABLE_FILES = ['package.json', 'bun.lock'] as const

// Resolves the jail layout for a recognized standalone dependency install
// (`bun add` / `bun install`). The RW root lets bun create node_modules/ and its
// temp lockfile (`bun.lock.NNN.tmp`, renamed) — a file-level bind of `bun.lock`
// alone cannot, since the temp file needs DIRECTORY write. Pre-creates an empty
// node_modules/ so the dir exists before the RW root bind. Then RO-binds every
// EXISTING root entry not in the writable allowlist (readdir enumeration, so a
// new file like `src/` or a planted `cron.json` is covered without a hardcoded
// list), plus `node_modules/typeclaw` (the live/symlinked runtime, nested under
// the writable node_modules) and the whole `.git` (a `bun add` never needs git,
// so RO-binding it wholesale is simpler and safer than the hooks/config carve-out
// — it closes the hook / core.hooksPath escalation by construction).
//
// SECURITY: rejects a symlink at agentDir, at any install-touched path
// (node_modules, package.json, bun.lock), and at every RO-bind source — an RW
// root or an RO bind that follows a symlink would write/read outside the jail.
// The secret/private masks render AFTER this protected set (subtractMasked in
// applyBashSandbox drops any protected entry a mask already hides), so .env /
// secrets.json / memory / sessions stay hidden, not merely RO.
export async function resolvePackageInstallZones(agentDir: string): Promise<PackageInstallZones> {
  await assertNotSymlink(agentDir)
  await mkdir(join(agentDir, 'node_modules'), { recursive: true })
  for (const rel of ['node_modules', ...PACKAGE_INSTALL_WRITABLE_FILES] as const) {
    const target = join(agentDir, rel)
    if (await exists(target)) await assertNotSymlink(target)
  }

  const writable = new Set<string>([...PACKAGE_INSTALL_WRITABLE_DIRS, ...PACKAGE_INSTALL_WRITABLE_FILES])
  const dirs: string[] = []
  const files: string[] = []
  for (const entry of await readdir(agentDir, { withFileTypes: true })) {
    if (writable.has(entry.name)) continue
    // A symlinked root entry is skipped, not RO-bound: an RO bind follows it to
    // an outside target. Skipping leaves it under the RW root — but it is the
    // agent's OWN symlink under its OWN root, contained by the agent-folder bind
    // and the always-on kernel invariants, the same residual the default jail
    // accepts for symlinks pointing outside /agent.
    if (entry.isSymbolicLink()) continue
    const target = join(agentDir, entry.name)
    if (entry.isDirectory()) dirs.push(target)
    else if (entry.isFile()) files.push(target)
  }

  // node_modules itself is writable (deps land there), but the runtime under it
  // must not be — RO-bind it nested, last-op-wins over the writable node_modules.
  const runtime = join(agentDir, 'node_modules', 'typeclaw')
  if (await isRealEntry(runtime, 'dir')) dirs.push(runtime)

  // Guarded managed files: a PRESENT real one is already RO-bound by the readdir
  // loop above (it is not in the writable set). The gap is a managed file ABSENT
  // at jail-build time — readdir never sees it, so nothing occupies its path and
  // a postinstall script could CREATE it under the RW root. Block that path with
  // `--ro-bind /dev/null`. A managed file that exists as a SYMLINK is also blocked
  // here rather than RO-bound (the readdir loop skipped it, and an RO bind would
  // follow it out of the jail) — occupying the path with /dev/null is safe.
  const blockedCreation: string[] = []
  for (const name of MANAGED_ROOT_FILES) {
    const target = join(agentDir, name)
    if (!(await isRealEntry(target, 'file'))) blockedCreation.push(target)
  }

  return {
    root: agentDir,
    protected: { dirs: dedupe(dirs), files: dedupe(files) },
    blockedCreation: dedupe(blockedCreation),
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
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
