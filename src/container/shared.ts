import { basename, resolve } from 'node:path'

export type DockerExecResult = { exitCode: number; stdout: string; stderr: string }

export type DockerExec = (
  args: string[],
  options?: { cwd?: string; inheritStdio?: boolean; signal?: AbortSignal },
) => Promise<DockerExecResult>

export const defaultDockerExec: DockerExec = async (args, options) => {
  const bun = getBun()
  if (!bun) return { exitCode: -1, stdout: '', stderr: 'bun runtime not available' }
  // Bun.spawn throws synchronously with code 'ENOENT' when docker isn't on
  // $PATH (rather than returning a non-zero exit). Two overloads (pipe vs
  // inherit) so each spawn call site has the literal stdout/stderr type
  // attached — that's what lets `new Response(proc.stdout)` typecheck on
  // the piped path. `signal` is forwarded to Bun.spawn so callers can bound
  // long-running docker subcommands (e.g. `docker logs` on a stuck daemon).
  if (options?.inheritStdio) {
    try {
      const proc = bun.spawn({
        cmd: ['docker', ...args],
        cwd: options.cwd,
        stdout: 'inherit',
        stderr: 'inherit',
        signal: options.signal,
      })
      return { exitCode: await proc.exited, stdout: '', stderr: '' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { exitCode: -1, stdout: '', stderr: DOCKER_NOT_FOUND_STDERR }
      }
      throw error
    }
  }
  try {
    const proc = bun.spawn({
      cmd: ['docker', ...args],
      cwd: options?.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: options?.signal,
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { exitCode, stdout, stderr }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exitCode: -1, stdout: '', stderr: DOCKER_NOT_FOUND_STDERR }
    }
    throw error
  }
}

// Sentinel stderr from defaultDockerExec when Bun.spawn throws ENOENT.
// checkDockerAvailable matches on this exact string to distinguish
// "binary missing" from "daemon down".
export const DOCKER_NOT_FOUND_STDERR = 'docker: command not found in $PATH'

// Collapse a multi-line `docker` CLI stderr into a single readable clause
// suitable for inline `reason:` strings. The motivating case is `compose
// restart`, which prints one row per agent — raw stderr from a failed
// `docker run` is 3-5 lines (leading `docker: ` prefix, daemon error body,
// blank line, "Run 'docker run --help' for more information" tail) and
// turns each failing row into an ASCII wall. Strip the boilerplate, drop
// the help-pointer tail (it's noise in a programmatic context — users who
// hit it can run `docker run --help` themselves), and join any remaining
// detail lines with "; " so the result fits on the same row as the
// `✖ [name] failed:` prefix that wraps it.
export function sanitizeDockerStderr(stderr: string): string {
  const withoutHelpTail = stderr.replace(/\n*\s*Run '[^']+--help' for more information\s*\n?/g, '')
  const lines = withoutHelpTail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^docker:\s*/, '').replace(/^Error response from daemon:\s*/, ''))
    .filter((line) => line.length > 0)
  return lines.join('; ')
}

export type DockerAvailability = { ok: true } | { ok: false; reason: 'binary-missing' | 'daemon-down'; detail: string }

// `docker info --format {{.ServerVersion}}` is the probe of choice because it
// requires both the client AND a reachable daemon. `docker --version` would
// miss the "Docker Desktop installed but not running" case, which is the
// common failure mode on macOS.
export async function checkDockerAvailable(exec: DockerExec = defaultDockerExec): Promise<DockerAvailability> {
  const result = await exec(['info', '--format', '{{.ServerVersion}}'])
  if (result.exitCode === 0) return { ok: true }
  if (result.stderr === DOCKER_NOT_FOUND_STDERR) {
    return { ok: false, reason: 'binary-missing', detail: result.stderr }
  }
  return {
    ok: false,
    reason: 'daemon-down',
    detail: result.stderr.trim() || `docker info exited with code ${result.exitCode}`,
  }
}

export function containerNameFromCwd(cwd: string): string {
  return sanitizeContainerName(basename(resolve(cwd)))
}

// `docker rm` failures we treat as recoverable. The kind matters for the
// caller's next step:
//   - 'gone'        — "No such container". The container is already removed
//                     (peer `typeclaw stop`, manual `docker rm`, or async
//                     post-stop cleanup that finished first). The name is
//                     free to reuse immediately.
//   - 'in-progress' — "removal of container … is already in progress". Docker
//                     accepted a prior remove and is still draining it. The
//                     container is STILL PRESENT in `docker inspect` until
//                     the drain completes, so a `docker run --name <same>`
//                     fired right now would collide. Callers that follow
//                     `rm` with `run` MUST wait for the container to
//                     actually disappear — see waitForRemoval.
//   - null          — non-benign failure; surface as an error.
export type BenignRmKind = 'gone' | 'in-progress' | null

export function classifyRmStderr(stderr: string): BenignRmKind {
  const lower = stderr.toLowerCase()
  if (lower.includes('no such container')) return 'gone'
  if (lower.includes('removal of container')) return 'in-progress'
  return null
}

// Detects Docker's name-conflict response from `docker run --name <X>`:
//   docker: Error response from daemon: Conflict. The container name
//   "/<X>" is already in use by container "<id>". You have to remove
//   (or rename) that container to be able to reuse that name.
//
// This is the user-visible failure mode behind `typeclaw compose restart`
// even after stop()/start()'s preflight already waited for `docker inspect`
// to report the container gone. Docker maintains TWO pieces of state for a
// container name: the container record (visible to `inspect` / `ps -a`) and
// a separate name-reservation entry checked by `docker run --name`. Under
// load — most reliably reproduced on OrbStack with N parallel agents
// restarting via `Promise.all` — those two drain at different times. The
// container record drops first; the name reservation lingers tens to
// hundreds of ms longer. `waitForRemoval` polls the container record, so
// it can return "gone" while `docker run --name <same>` still loses on the
// reservation.
//
// The robust signal is the operation we actually need to succeed: probe by
// running `docker run` itself and retry on conflict. classifyRmStderr
// covers `docker rm`'s benign cases; this helper covers `docker run`'s.
//
// Matches case-insensitively on the canonical phrasing across Docker
// Engine, Docker Desktop, and OrbStack. The (or rename) clause is the
// most stable substring across vendor message variants.
export function isContainerNameConflict(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return lower.includes('container name') && lower.includes('is already in use')
}

// Polls `docker inspect` until the named container is gone or the deadline
// elapses. Required after a `docker rm` that returned "removal of container
// … is already in progress": Docker has committed to removal but has not
// finished, so the name is briefly still taken. Without this wait, the
// caller's subsequent `docker run --name <same>` races the daemon's
// removal-drain and intermittently fails with a name conflict (the
// user-visible symptom under `typeclaw compose restart` and any restart of
// a container that hostd's GC tick raced ahead on). Returns true if the
// container disappeared before the deadline, false on timeout.
//
// NOTE: `inspect` reporting "gone" is necessary but NOT sufficient for
// `docker run --name <same>` to succeed — Docker's name-reservation table
// drains independently. waitForRemoval is the fast path; the retry on
// `docker run` (see isContainerNameConflict) is the safety net.
export async function waitForRemoval(
  exec: DockerExec,
  name: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await exec(['inspect', '--format', '{{.State.Running}}', name])
    if (result.exitCode !== 0) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  const final = await exec(['inspect', '--format', '{{.State.Running}}', name])
  return final.exitCode !== 0
}

export function imageTagFromCwd(cwd: string): string {
  return `typeclaw-${containerNameFromCwd(cwd)}`
}

// Docker container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*.
function sanitizeContainerName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.-]/g, '-')
  if (cleaned === '' || !/^[a-zA-Z0-9]/.test(cleaned)) {
    return `tc-${cleaned || 'agent'}`
  }
  return cleaned
}

export async function imageExists(tag: string): Promise<boolean> {
  const bun = getBun()
  if (!bun) return false
  const proc = bun.spawn({
    cmd: ['docker', 'image', 'inspect', tag],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (await proc.exited) === 0
}

export async function containerExists(name: string): Promise<boolean> {
  return (await inspectContainer(name)).exists
}

export type ContainerState = { exists: false } | { exists: true; running: boolean }

// `docker inspect` is the canonical way to ask Docker about a single container
// by name. It returns exit 0 with `true`/`false` when the container exists (in
// any state: running, exited, dead, or being removed) and exit 1 otherwise.
// We deliberately do NOT use `docker ps` / `docker ps -a` here because the
// State.Running boolean — not mere presence in `ps -a` — is what callers need
// to distinguish a live agent from a corpse left over after a crash (which,
// since we run without `--rm`, sticks around in `ps -a` until the next start).
export async function inspectContainer(name: string): Promise<ContainerState> {
  const bun = getBun()
  if (!bun) return { exists: false }
  const proc = bun.spawn({
    cmd: ['docker', 'inspect', '--format', '{{.State.Running}}', name],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await proc.exited) !== 0) return { exists: false }
  const out = (await new Response(proc.stdout).text()).trim()
  return { exists: true, running: out === 'true' }
}

export function getBun(): { spawn: typeof Bun.spawn } | undefined {
  return (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
}
