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

// `docker rm` failures we treat as success because they leave the name free
// for the next `docker run --name <same>`, which is the post-state every
// caller is trying to achieve:
//   - "No such container" — removed out-of-band between our inspect and rm
//     (peer `typeclaw stop`, manual `docker rm`, or async post-stop cleanup).
//   - "removal of container … is already in progress" — Docker accepted a
//     prior remove and is still draining it. start.ts's preflight re-runs
//     `rm -f` with the same tolerance and Docker serializes, so the name is
//     free by the time `docker run` fires.
export function isBenignRmStderr(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return lower.includes('no such container') || lower.includes('removal of container')
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
