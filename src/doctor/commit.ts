import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { CommitOutcome, FixAttempt } from './types'

export type CommitOptions = {
  cwd: string
  attempts: FixAttempt[]
  spawnGit?: SpawnGit
}

export type GitResult = { exitCode: number; stdout: string; stderr: string }
export type SpawnGit = (args: string[], cwd: string) => Promise<GitResult>

export async function commitAutoFixes(opts: CommitOptions): Promise<CommitOutcome> {
  const successes = opts.attempts.filter((a): a is Extract<FixAttempt, { ok: true }> => a.ok === true)
  if (successes.length === 0) {
    return { kind: 'skipped', reason: 'no successful auto-fixes' }
  }

  const requested = uniqueSorted(successes.flatMap((a) => a.changedPaths))
  if (requested.length === 0) {
    return { kind: 'skipped', reason: 'auto-fixes reported no changed paths' }
  }

  if (!existsSync(join(opts.cwd, '.git'))) {
    return { kind: 'skipped', reason: 'agent folder is not a git repo (.git missing)' }
  }

  const spawnGit = opts.spawnGit ?? defaultSpawnGit

  const filter = await filterCommittable(spawnGit, opts.cwd, requested)
  if (filter.kind === 'failed') return filter
  const pathsStaged = filter.paths
  if (pathsStaged.length === 0) {
    return {
      kind: 'skipped',
      reason: `all changed path(s) are gitignored or untracked-and-ignored (${requested.join(', ')})`,
    }
  }

  const add = await spawnGit(['add', '--', ...pathsStaged], opts.cwd)
  if (add.exitCode !== 0) {
    return { kind: 'failed', reason: `git add failed: ${add.stderr.trim() || `exit ${add.exitCode}`}` }
  }

  const message = buildCommitMessage(opts.attempts)
  const commit = await spawnGit(['commit', '-m', message, '--only', '--', ...pathsStaged], opts.cwd)
  if (commit.exitCode !== 0) {
    return { kind: 'failed', reason: `git commit failed: ${commit.stderr.trim() || `exit ${commit.exitCode}`}` }
  }

  const sha = await spawnGit(['rev-parse', 'HEAD'], opts.cwd)
  const commitSha = sha.exitCode === 0 ? sha.stdout.trim() : ''
  return { kind: 'committed', commitSha, pathsStaged }
}

// TypeClaw-owned files like `Dockerfile` live in the "truly-ignored" gitignore
// category — they're regenerated from the CLI template on every `typeclaw
// start`, so tracking them would produce noisy "Update Dockerfile" commits.
// `commitSystemFile` in src/container/start.ts skips them silently because
// `git status --porcelain -- <ignored>` returns empty. We replicate that
// behavior here so `doctor --fix` produces the same skip semantics instead
// of failing with `git add` hints about the ignored file.
//
// A non-zero git-status exit IS NOT the same signal as 'empty stdout' — the
// former means git itself failed (broken index, malformed pathspec, etc.).
// Surface that as { kind: 'failed' } so the user sees the real cause instead
// of a misleading 'all paths are gitignored' message.
async function filterCommittable(
  spawnGit: SpawnGit,
  cwd: string,
  paths: string[],
): Promise<{ kind: 'ok'; paths: string[] } | { kind: 'failed'; reason: string }> {
  const out: string[] = []
  for (const p of paths) {
    const status = await spawnGit(['status', '--porcelain', '--', p], cwd)
    if (status.exitCode !== 0) {
      return {
        kind: 'failed',
        reason: `git status failed for ${p}: ${status.stderr.trim() || `exit ${status.exitCode}`}`,
      }
    }
    if (status.stdout.trim().length > 0) out.push(p)
  }
  return { kind: 'ok', paths: out }
}

export function buildCommitMessage(attempts: FixAttempt[]): string {
  const successes = attempts.filter((a): a is Extract<FixAttempt, { ok: true }> => a.ok === true)
  const subject = `typeclaw doctor: auto-fix ${successes.length} issue${successes.length === 1 ? '' : 's'}`
  const body = successes.map((a) => `- [${a.source}] ${a.name}: ${a.summary}`).join('\n')
  return `${subject}\n\n${body}\n`
}

const defaultSpawnGit: SpawnGit = async (args, cwd) => {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { exitCode: -1, stdout: '', stderr: 'bun runtime not available' }
  try {
    const proc = bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { exitCode, stdout, stderr }
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}
