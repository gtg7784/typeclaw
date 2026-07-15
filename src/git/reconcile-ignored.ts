import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYSTEM_MANAGED_ROOTS, TRULY_IGNORED_PATTERNS } from '@/init/gitignore'

import { hooklessGitArgs } from './hookless'
import { type AgentGit, resolveAgentGit } from './resolve-agent-git'

export type UntrackResult = { untracked: string[] }

// Removes from the index any tracked file that now matches a truly-ignored
// rule. .gitignore only affects UNtracked files, so a file committed before its
// ignore rule existed (e.g. public/review.json after `public/` was added to the
// template) keeps getting tracked forever; this reconciles that on every start.
// Files are removed with --cached, so they stay on disk.
//
// Best-effort, like commitSystemFile: no-ops when the folder is not a git repo,
// Bun is missing, the repo has no matching tracked files, or any git step fails.
// Never throws — start() hygiene must not block boot. The removals are staged
// but NOT committed here; the caller folds them into the .gitignore commit so
// the rule change and its index cleanup land atomically.
export async function untrackTrulyIgnoredFiles(
  cwd: string,
  customAppend: readonly string[] = [],
): Promise<UntrackResult> {
  const empty: UntrackResult = { untracked: [] }

  const bun = getBun()
  if (!bun) return empty
  const repo = resolveAgentGit(cwd)
  if (!repo) return empty

  const patterns = [...TRULY_IGNORED_PATTERNS, ...customAppend]
  let excludeDir: string | null = null
  try {
    excludeDir = await mkdtemp(join(tmpdir(), 'typeclaw-untrack-'))
    const excludeFile = join(excludeDir, 'exclude')
    await writeFile(excludeFile, `${patterns.join('\n')}\n`)

    const candidates = await listTrackedIgnored(bun, cwd, repo.gitArgs, excludeFile)
    const removable = candidates.filter((path) => !isSystemManaged(path))
    if (removable.length === 0) return empty

    const removed = await gitRmCached(bun, cwd, repo.gitArgs, removable)
    return { untracked: removed }
  } catch {
    return empty
  } finally {
    if (excludeDir) await rm(excludeDir, { recursive: true, force: true }).catch(() => {})
  }
}

// Commits exactly { .gitignore + the untrack removals } in one commit, leaving
// any UNRELATED user-staged work out of the commit but still staged.
//
// Why plumbing instead of `git commit -- <paths>`: a pathspec/--only commit
// re-snapshots the listed paths from the WORKING TREE, so a `git rm --cached`
// removal of a file that still exists on disk gets silently re-added. A plain
// `git commit` gets the removal right but sweeps in unrelated staged work. So
// we build the exact tree in a throwaway index seeded from HEAD, commit-tree
// it, and compare-and-swap HEAD via update-ref (race-safe against concurrent
// HEAD moves). This bypasses commit hooks, which is fine for a system commit.
//
// Caller contract: the REAL index already has .gitignore staged and the
// untracked paths removed (via git rm --cached). update-ref then makes the
// real index match the new HEAD, so those paths read clean afterward.
//
// If the plumbing path can't run (no HEAD, update-ref CAS race, transient git
// failure) we fall back to a plain `git commit` of the real index — but ONLY
// when the staged set is exactly { .gitignore + the removals }. This guarantees
// start()'s hygiene rewrite never gets stranded staged-but-uncommitted (leaving
// the repo dirty), while the staged-set check still protects any pre-existing
// user-staged work from being swept into the fallback commit.
export type CommitGitignoreDeps = {
  // Seam so tests can force the plumbing path to fail and exercise the fallback;
  // a real update-ref CAS race or transient git failure is otherwise hard to
  // reproduce deterministically. Defaults to the real temp-index commit.
  commitAtomic?: (
    bun: BunLike,
    cwd: string,
    repo: AgentGit,
    gitignoreFile: string,
    untracked: readonly string[],
    message: string,
  ) => Promise<boolean>
}

export async function commitGitignoreWithUntracks(
  cwd: string,
  gitignoreFile: string,
  untracked: readonly string[],
  message: string,
  deps: CommitGitignoreDeps = {},
): Promise<boolean> {
  const bun = getBun()
  if (!bun) return false
  const repo = resolveAgentGit(cwd)
  if (!repo) return false
  if (untracked.length === 0) return false

  const commitAtomic = deps.commitAtomic ?? commitViaTempIndex
  if (!(await run(bun, cwd, repo.gitArgs, ['add', '--', gitignoreFile]))) return false
  if (await commitAtomic(bun, cwd, repo, gitignoreFile, untracked, message)) return true
  return await commitRealIndexIfExactlyOurs(bun, cwd, repo.gitArgs, gitignoreFile, untracked, message)
}

async function commitViaTempIndex(
  bun: BunLike,
  cwd: string,
  repo: AgentGit,
  gitignoreFile: string,
  untracked: readonly string[],
  message: string,
): Promise<boolean> {
  let indexDir: string | null = null
  try {
    const parent = (await capture(bun, cwd, repo.gitArgs, ['rev-parse', '--verify', 'HEAD'])).trim()
    if (parent.length === 0) return false

    indexDir = await mkdtemp(join(tmpdir(), 'typeclaw-untrack-idx-'))
    const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, 'index') }
    if (!(await run(bun, cwd, repo.gitArgs, ['read-tree', parent], env))) return false
    if (!(await run(bun, cwd, repo.gitArgs, ['add', '--', gitignoreFile], env))) return false
    if (!(await forceRemove(bun, cwd, repo.gitArgs, untracked, env))) return false

    const tree = (await capture(bun, cwd, repo.gitArgs, ['write-tree'], env)).trim()
    if (tree.length === 0) return false
    const commit = (await capture(bun, cwd, repo.gitArgs, ['commit-tree', tree, '-p', parent, '-m', message])).trim()
    if (commit.length === 0) return false

    return await run(bun, cwd, repo.gitArgs, ['update-ref', '-m', message, 'HEAD', commit, parent])
  } catch {
    return false
  } finally {
    if (indexDir) await rm(indexDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function commitRealIndexIfExactlyOurs(
  bun: BunLike,
  cwd: string,
  gitArgs: readonly string[],
  gitignoreFile: string,
  untracked: readonly string[],
  message: string,
): Promise<boolean> {
  const staged = (await capture(bun, cwd, gitArgs, ['diff', '--cached', '--name-only', '-z']))
    .split('\0')
    .filter((entry) => entry.length > 0)
  if (staged.length === 0) return false

  const expected = new Set([gitignoreFile, ...untracked])
  if (staged.length !== expected.size || !staged.every((path) => expected.has(path))) return false

  return await run(bun, cwd, gitArgs, ['commit', '-m', message])
}

// Hardcoded fail-closed guard: even if a custom git.ignore.append pattern
// matches a system-managed root, never untrack it. The git ls-files match is
// against the truly-ignored set only, but custom patterns are user-supplied and
// could be arbitrarily broad (`**`), so re-check here as the last line.
function isSystemManaged(path: string): boolean {
  return SYSTEM_MANAGED_ROOTS.some((root) => path === root.replace(/\/$/, '') || path.startsWith(root))
}

async function listTrackedIgnored(
  bun: BunLike,
  cwd: string,
  gitArgs: readonly string[],
  excludeFile: string,
): Promise<string[]> {
  const proc = bun.spawn({
    cmd: ['git', ...hooklessGitArgs([...gitArgs, 'ls-files', '-z', '-c', '-i', '--exclude-from', excludeFile])],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await proc.exited) !== 0) return []
  const raw = await new Response(proc.stdout).text()
  return raw.split('\0').filter((entry) => entry.length > 0)
}

async function gitRmCached(bun: BunLike, cwd: string, gitArgs: readonly string[], files: string[]): Promise<string[]> {
  const proc = bun.spawn({
    cmd: ['git', ...hooklessGitArgs([...gitArgs, 'rm', '--cached', '-q', '--', ...files])],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await proc.exited) !== 0) return []
  return files
}

type GitEnv = Record<string, string | undefined>

async function run(
  bun: BunLike,
  cwd: string,
  gitArgs: readonly string[],
  args: readonly string[],
  env?: GitEnv,
): Promise<boolean> {
  const proc = bun.spawn({
    cmd: ['git', ...hooklessGitArgs([...gitArgs, ...args])],
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (await proc.exited) === 0
}

async function capture(
  bun: BunLike,
  cwd: string,
  gitArgs: readonly string[],
  args: readonly string[],
  env?: GitEnv,
): Promise<string> {
  const proc = bun.spawn({
    cmd: ['git', ...hooklessGitArgs([...gitArgs, ...args])],
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await proc.exited) !== 0) return ''
  return await new Response(proc.stdout).text()
}

// --force-remove drops the index entry regardless of the file existing on disk;
// the NUL-delimited stdin form is safe for paths with spaces/newlines.
async function forceRemove(
  bun: BunLike,
  cwd: string,
  gitArgs: readonly string[],
  files: readonly string[],
  env: GitEnv,
): Promise<boolean> {
  const proc = bun.spawn({
    cmd: ['git', ...hooklessGitArgs([...gitArgs, 'update-index', '-z', '--force-remove', '--stdin'])],
    cwd,
    env,
    stdin: new TextEncoder().encode(files.join('\0')),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (await proc.exited) === 0
}

type BunLike = { spawn: typeof Bun.spawn }

function getBun(): BunLike | undefined {
  return (globalThis as { Bun?: BunLike }).Bun
}
