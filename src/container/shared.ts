import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'

export type DockerExecResult = { exitCode: number; stdout: string; stderr: string }

export type DockerExec = (
  args: string[],
  options?: { cwd?: string; inheritStdio?: boolean; signal?: AbortSignal },
) => Promise<DockerExecResult>

export const defaultDockerExec: DockerExec = async (args, options) => {
  const bun = getBun()
  if (!bun) return { exitCode: -1, stdout: '', stderr: 'bun runtime not available' }
  // Resolve `docker` to an absolute path before spawning. Bun.spawn() resolves
  // a bare command name through Bun.which() internally, but Windows PATH/PATHEXT
  // resolution has a string of historical bugs (oven-sh/bun#16070, #11182,
  // #29636) that make `cmd: ['docker', …]` throw ENOENT even when Docker
  // Desktop is installed and docker.exe is on %PATH% — surfacing as the
  // misleading "Docker is not installed." on a machine that has Docker.
  // dockerCmd() goes through Bun.which(), which reliably honors PATHEXT and
  // returns the full docker.exe path; it returns null only when docker is
  // genuinely absent from PATH, which maps to the binary-missing sentinel.
  const cmd = dockerCmd(args)
  if (cmd === null) return { exitCode: -1, stdout: '', stderr: DOCKER_NOT_FOUND_STDERR }
  // Two overloads (pipe vs inherit) so each spawn call site has the literal
  // stdout/stderr type attached — that's what lets `new Response(proc.stdout)`
  // typecheck on the piped path. `signal` is forwarded to Bun.spawn so callers
  // can bound long-running docker subcommands (e.g. `docker logs` on a stuck
  // daemon). The ENOENT catch stays as a safety net for the race where the
  // binary disappears between resolution and spawn.
  if (options?.inheritStdio) {
    try {
      const proc = bun.spawn({
        cmd,
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
      cmd,
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

// Sentinel stderr from defaultDockerExec when docker can't be resolved/spawned.
// checkDockerAvailable matches on this exact string to distinguish
// "binary missing" from "daemon down".
export const DOCKER_NOT_FOUND_STDERR = 'docker: command not found in $PATH'

// Resolves the `docker` binary to an absolute path via Bun.which(), which —
// unlike a bare `cmd: ['docker']` handed to Bun.spawn() — reliably honors
// Windows PATHEXT and returns e.g. C:\…\docker.exe. On POSIX the resolved path
// equals what the bare name would have found. Returns null when docker is not
// on PATH, which callers translate into the binary-missing sentinel.
export function resolveDockerBinary(): string | null {
  return getBun()?.which('docker') ?? null
}

// Builds the argv for a docker invocation with the binary resolved to an
// absolute path (see resolveDockerBinary). Returns null when docker is absent
// from PATH. The resolver is injectable so callers and tests stay deterministic
// without depending on a real docker install.
export function dockerCmd(args: string[], resolveBinary: () => string | null = resolveDockerBinary): string[] | null {
  const binary = resolveBinary()
  return binary === null ? null : [binary, ...args]
}

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

// `docker buildx version` exits 0 only when the buildx CLI plugin is installed.
// `start` uses this to pick the build path: buildx present -> `docker buildx
// build` with the BuildKit Dockerfile (`--mount=type=cache` + the `# syntax=`
// pragma, fast cached rebuilds); absent -> a BuildKit-stripped Dockerfile built
// with the legacy `docker build`. Either way the agent image builds.
export async function buildxAvailable(exec: DockerExec = defaultDockerExec): Promise<boolean> {
  return (await exec(['buildx', 'version'])).exitCode === 0
}

export type BindMountSpec = { src: string; dst: string; readonly?: boolean }

// Emits `--mount type=bind,...` argv for a host->container bind mount, used in
// place of the legacy `-v src:dst[:ro]` form. The `-v` short form splits on
// `:`, which collides with a Windows drive letter (`C:\agent` parses as host
// `C` + path `\agent`); `--mount`'s `key=value` CSV has no such ambiguity and
// fails loud on an unknown/missing key instead of silently creating a phantom
// host dir. Src is resolved to an absolute path because `--mount` (unlike `-v`)
// rejects relative sources. A literal comma in a path would break the CSV;
// it's rejected here rather than silently mis-parsed (paths with commas are
// pathological and were never supported by the `-v` form either).
export function dockerBindMount({ src, dst, readonly }: BindMountSpec): [string, string] {
  const absSrc = resolve(src)
  if (absSrc.includes(',') || dst.includes(',')) {
    throw new Error(`bind mount path contains a comma, which docker --mount cannot express: ${absSrc} -> ${dst}`)
  }
  const fields = [`type=bind`, `src=${absSrc}`, `dst=${dst}`]
  if (readonly) fields.push('readonly')
  return ['--mount', fields.join(',')]
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
// The dominant cause of this error in `typeclaw compose restart` is NOT a
// transient name-reservation drain (PR #121's hypothesis) but a concrete
// corpse left behind by an earlier `docker run` in the same start() call
// that failed AFTER Docker created the container record. The canonical
// path: compose restart fires N agents in parallel via Promise.all; they
// race for the preferred host port; the loser's `docker run -p <busy>:...`
// fails with "port is already allocated", and depending on the daemon
// version Docker may have already created the container record before the
// port bind failed. start()'s port-TOCTOU retry then re-runs `docker run`
// with a fresh ephemeral port but the SAME --name, and hits this conflict
// against the corpse from the previous attempt. The corpse is stable —
// sleep-only retries cannot make it go away.
//
// The fix is destructive: when this error fires for a non-running same-name
// container, force-remove it before retrying. See cleanupRunCorpse for the
// safety contract (only force-remove containers that are NOT running, so a
// concurrent legitimate start of the same name is never killed).
//
// Matches case-insensitively on the canonical phrasing across Docker
// Engine, Docker Desktop, and OrbStack. The (or rename) clause is the
// most stable substring across vendor message variants.
export function isContainerNameConflict(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return lower.includes('container name') && lower.includes('is already in use')
}

// Result of probing whether a previous `docker run --name <X>` left a corpse
// blocking the next run:
//   - 'gone'     — no container with that name. Safe to `docker run --name`.
//   - 'removed'  — corpse existed and was force-removed (and waitForRemoval
//                  confirmed it disappeared). Safe to `docker run --name`.
//   - 'running'  — a container with that name is currently RUNNING. We did
//                  NOT remove it. Caller must NOT proceed with `docker run
//                  --name <same>`: that would either fail again or imply a
//                  concurrent legitimate start that we should not kill.
//   - 'stuck'    — corpse existed but did not disappear within waitForRemoval
//                  budget. Caller should surface a clear error rather than
//                  loop forever.
export type CorpseCleanupOutcome = 'gone' | 'removed' | 'running' | 'stuck'

// Inspects the named container; if a non-running corpse is holding the
// name (the failure mode behind `typeclaw compose restart`'s persistent
// Conflict errors), force-removes it and waits for the removal to drain.
// Explicitly refuses to touch a RUNNING container so that a concurrent
// legitimate start of the same name (or a foreign-but-named container the
// user wants kept alive) is never killed by this cleanup path. Errors from
// the rm itself are folded into 'stuck' so the caller can surface a single
// "still here" reason rather than chase docker stderr variants.
//
// The rm is keyed on the container ID we read from the same inspect call,
// NOT on the name. This closes the TOCTOU window where another process
// could create a live container with the same name between our inspect
// (saw a non-running corpse with ID A) and our rm: removing by name would
// kill the new live container with ID B, but removing by ID A targets the
// specific corpse we measured. If ID A is already gone by the time rm
// fires (e.g. a concurrent cleanup beat us), the rm returns "No such
// container" which classifyRmStderr folds into 'gone'. waitForRemoval
// is still keyed on name because that's what the caller's next
// `docker run --name <name>` will actually collide on.
export async function cleanupRunCorpse(exec: DockerExec, name: string): Promise<CorpseCleanupOutcome> {
  const probe = await exec(['inspect', '--format', '{{.Id}}|{{.State.Running}}', name])
  if (probe.exitCode !== 0) return 'gone'
  const [id = '', running = ''] = probe.stdout.trim().split('|')
  if (running === 'true') return 'running'
  if (id === '') return 'stuck'
  const rm = await exec(['rm', '-f', id])
  if (rm.exitCode !== 0) {
    const kind = classifyRmStderr(rm.stderr)
    if (kind === 'gone') return 'gone'
    if (kind === null) return 'stuck'
  }
  return (await waitForRemoval(exec, name)) ? 'removed' : 'stuck'
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
//
// Non-ASCII names (Korean/CJK/Cyrillic/accented Latin — the common Windows case
// where the profile folder is a localized display name, e.g. C:\Users\사용자\봇)
// have every out-of-charset character collapsed to a dash, so distinct folders
// reduce to the SAME string: '봇' and '집' both → 'tc--'. The container name keys
// hostd registration and the secrets key path, so that collision is silent
// host-side state clobbering, not cosmetics. For any name carrying a non-ASCII
// char we append a deterministic hash of the original (cf. makeUntitledSlug in
// the memory plugin) to keep distinct folders distinct; surviving ASCII stays a
// readable prefix. ASCII-only names take the original branch — never renamed.
function sanitizeContainerName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.-]/g, '-')
  if (/[^\u0000-\u007f]/.test(name)) {
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
    const remnant = cleaned.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
    if (remnant === '') return `tc-${hash}`
    const base = /^[a-zA-Z0-9]/.test(remnant) ? remnant : `tc-${remnant}`
    return `${base}-${hash}`
  }
  if (cleaned === '' || !/^[a-zA-Z0-9]/.test(cleaned)) {
    return `tc-${cleaned || 'agent'}`
  }
  return cleaned
}

export async function imageExists(tag: string): Promise<boolean> {
  const bun = getBun()
  if (!bun) return false
  const cmd = dockerCmd(['image', 'inspect', tag])
  if (cmd === null) return false
  const proc = bun.spawn({
    cmd,
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
  const cmd = dockerCmd(['inspect', '--format', '{{.State.Running}}', name])
  if (cmd === null) return { exists: false }
  const proc = bun.spawn({
    cmd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await proc.exited) !== 0) return { exists: false }
  const out = (await new Response(proc.stdout).text()).trim()
  return { exists: true, running: out === 'true' }
}

export function getBun(): { spawn: typeof Bun.spawn; which: typeof Bun.which } | undefined {
  return (globalThis as { Bun?: { spawn: typeof Bun.spawn; which: typeof Bun.which } }).Bun
}
