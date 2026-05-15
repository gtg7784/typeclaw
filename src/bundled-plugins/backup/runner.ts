import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const COMMIT_TIMEOUT_MS = 30_000
export const NETWORK_TIMEOUT_MS = 60_000

const RUNTIME_OWNED_PREFIXES = ['memory/'] as const
const FORCE_ADD_PREFIXES = ['sessions/'] as const

const NONINTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GCM_INTERACTIVE: 'never',
} as const

export type GitSpawnResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type GitSpawn = (args: readonly string[], opts: { cwd: string; timeoutMs: number }) => Promise<GitSpawnResult>

export type BackupRunnerDeps = {
  gitSpawn: GitSpawn
  pickCommitMessage: (input: { status: string; diffstat: string }) => Promise<string>
  diagnoseFailure?: (input: BackupFailureInput) => Promise<void>
  now?: () => number
}

export type BackupRunnerOptions = {
  cwd: string
  pushToOrigin: boolean
}

export type BackupFailureInput = {
  cwd: string
  stage: 'push' | 'rebase'
  exitCode: number
  stderr: string
  stdout: string
}

export type BackupResult =
  | { ok: true; kind: 'no-repo' | 'clean' | 'committed' | 'pushed' | 'rebased-and-pushed' }
  | { ok: false; kind: 'commit-failed' | 'push-failed' | 'rebase-failed' | 'aborted'; reason: string }

export async function runBackup(options: BackupRunnerOptions, deps: BackupRunnerDeps): Promise<BackupResult> {
  const { cwd, pushToOrigin } = options

  if (!existsSync(join(cwd, '.git'))) return { ok: true, kind: 'no-repo' }

  const status = await deps.gitSpawn(['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (status.exitCode !== 0) return { ok: false, kind: 'aborted', reason: `git status failed: ${shortErr(status)}` }
  const dirty = filterAgentOwned(parsePorcelain(status.stdout))
  const force = filterForceAdd(parsePorcelain(status.stdout))
  if (dirty.length === 0 && force.length === 0) return { ok: true, kind: 'clean' }

  if (dirty.length > 0) {
    const add = await deps.gitSpawn(['add', '--', ...dirty], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
    if (add.exitCode !== 0) return { ok: false, kind: 'commit-failed', reason: `git add failed: ${shortErr(add)}` }
  }
  if (force.length > 0) {
    const present = force.filter((p) => existsSync(join(cwd, p)))
    if (present.length > 0) {
      const addF = await deps.gitSpawn(['add', '-f', '--', ...present], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
      if (addF.exitCode !== 0) {
        return { ok: false, kind: 'commit-failed', reason: `git add -f failed: ${shortErr(addF)}` }
      }
    }
  }

  const stagedCheck = await deps.gitSpawn(['diff', '--cached', '--quiet'], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
  if (stagedCheck.exitCode === 0) return { ok: true, kind: 'clean' }

  const diffstat = await deps.gitSpawn(['diff', '--cached', '--stat'], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
  const message = await deps.pickCommitMessage({
    status: status.stdout.slice(0, 4096),
    diffstat: diffstat.stdout.slice(0, 4096),
  })

  // `pickCommitMessage` may spawn a subagent (the backup plugin's
  // `backup-message`) whose session JSONL lands under `sessions/` after we
  // already staged. Without this second pass that file would sit dirty in
  // the worktree until the NEXT backup cycle, which would then commit it
  // and create another orphan via the same path — a steady-state of
  // one-cycle-behind churn. Re-status, filter to `sessions/` additions
  // only (don't accidentally stage user work that arrived during the
  // window), and force-add anything new.
  const reStatus = await deps.gitSpawn(['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (reStatus.exitCode === 0) {
    const lateForce = filterForceAdd(parsePorcelain(reStatus.stdout)).filter((p) => existsSync(join(cwd, p)))
    if (lateForce.length > 0) {
      const lateAdd = await deps.gitSpawn(['add', '-f', '--', ...lateForce], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
      if (lateAdd.exitCode !== 0) {
        return { ok: false, kind: 'commit-failed', reason: `git add -f (post-message) failed: ${shortErr(lateAdd)}` }
      }
    }
  }

  const safeMessage = sanitizeCommitMessage(message)
  const commit = await deps.gitSpawn(['commit', '-m', safeMessage], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
  if (commit.exitCode !== 0)
    return { ok: false, kind: 'commit-failed', reason: `git commit failed: ${shortErr(commit)}` }

  if (!pushToOrigin) return { ok: true, kind: 'committed' }

  const upstream = await deps.gitSpawn(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (upstream.exitCode !== 0) return { ok: true, kind: 'committed' }

  const upstreamRef = upstream.stdout.trim()
  if (upstreamRef.length === 0) return { ok: true, kind: 'committed' }

  const push = await deps.gitSpawn(['push'], { cwd, timeoutMs: NETWORK_TIMEOUT_MS })
  if (push.exitCode === 0) return { ok: true, kind: 'pushed' }

  if (!isNonFastForward(push)) {
    await maybeDiagnose(deps, { cwd, stage: 'push', exitCode: push.exitCode, stderr: push.stderr, stdout: push.stdout })
    return { ok: false, kind: 'push-failed', reason: shortErr(push) }
  }

  const fetch = await deps.gitSpawn(['fetch'], { cwd, timeoutMs: NETWORK_TIMEOUT_MS })
  if (fetch.exitCode !== 0) {
    await maybeDiagnose(deps, {
      cwd,
      stage: 'push',
      exitCode: fetch.exitCode,
      stderr: fetch.stderr,
      stdout: fetch.stdout,
    })
    return { ok: false, kind: 'push-failed', reason: `git fetch failed: ${shortErr(fetch)}` }
  }

  const rebase = await deps.gitSpawn(['rebase', upstreamRef], { cwd, timeoutMs: NETWORK_TIMEOUT_MS })
  if (rebase.exitCode !== 0) {
    await deps.gitSpawn(['rebase', '--abort'], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
    await maybeDiagnose(deps, {
      cwd,
      stage: 'rebase',
      exitCode: rebase.exitCode,
      stderr: rebase.stderr,
      stdout: rebase.stdout,
    })
    return { ok: false, kind: 'rebase-failed', reason: `git rebase failed: ${shortErr(rebase)}` }
  }

  const push2 = await deps.gitSpawn(['push'], { cwd, timeoutMs: NETWORK_TIMEOUT_MS })
  if (push2.exitCode !== 0) {
    await maybeDiagnose(deps, {
      cwd,
      stage: 'push',
      exitCode: push2.exitCode,
      stderr: push2.stderr,
      stdout: push2.stdout,
    })
    return { ok: false, kind: 'push-failed', reason: `git push (post-rebase) failed: ${shortErr(push2)}` }
  }
  return { ok: true, kind: 'rebased-and-pushed' }
}

async function maybeDiagnose(deps: BackupRunnerDeps, input: BackupFailureInput): Promise<void> {
  if (!deps.diagnoseFailure) return
  try {
    await deps.diagnoseFailure(input)
  } catch {
    // Diagnosis is advisory; never let it mask the original failure.
  }
}

function shortErr(r: GitSpawnResult): string {
  if (r.timedOut) return `timed out (exit ${r.exitCode})`
  const text = r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

function isNonFastForward(r: GitSpawnResult): boolean {
  const blob = `${r.stderr}\n${r.stdout}`.toLowerCase()
  return blob.includes('non-fast-forward') || blob.includes('updates were rejected')
}

export function parsePorcelain(stdout: string): string[] {
  const out: string[] = []
  for (const raw of stdout.split('\n')) {
    if (raw.length < 4) continue
    const rest = raw.slice(3)
    const arrowIdx = rest.indexOf(' -> ')
    out.push(arrowIdx === -1 ? rest : rest.slice(arrowIdx + 4))
  }
  return out
}

function filterAgentOwned(paths: readonly string[]): string[] {
  return paths.filter((p) => !RUNTIME_OWNED_PREFIXES.some((pre) => p.startsWith(pre)))
}

function filterForceAdd(paths: readonly string[]): string[] {
  return paths.filter((p) => FORCE_ADD_PREFIXES.some((pre) => p.startsWith(pre)))
}

function sanitizeCommitMessage(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'Backup'
  const subject = trimmed.split('\n')[0]?.slice(0, 200) ?? 'Backup'
  const rest = trimmed.split('\n').slice(1).join('\n').trim()
  return rest.length > 0 ? `${subject}\n\n${rest}` : subject
}

export function makeDefaultGitSpawn(): GitSpawn {
  return async (args, { cwd, timeoutMs }) => {
    const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
    if (!bun) {
      return { exitCode: 127, stdout: '', stderr: 'Bun runtime not available', timedOut: false }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const proc = bun.spawn({
        cmd: ['git', ...args],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...NONINTERACTIVE_ENV },
        signal: controller.signal,
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const timedOut = controller.signal.aborted
      return { exitCode, stdout, stderr, timedOut }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        exitCode: 1,
        stdout: '',
        stderr: message,
        timedOut: controller.signal.aborted,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
