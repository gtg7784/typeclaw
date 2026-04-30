import { basename, resolve } from 'node:path'

export function containerNameFromCwd(cwd: string): string {
  return sanitizeContainerName(basename(resolve(cwd)))
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
// by name. It returns exit 0 with JSON when the container exists (in any state:
// running, exited, dead, or being removed) and exit 1 otherwise. We deliberately
// do NOT use `docker ps` / `docker ps -a` here because they expose a transient
// window after `docker stop` returns: with `--rm`, the daemon removes the
// container asynchronously, and during removal the container can still appear
// in `ps -a`, leading callers (e.g. start preflight) to misclassify a dying
// container as "already running".
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

// Polls until the named container is gone or the deadline elapses. Used after
// `docker stop` on a `--rm` container to close the auto-removal race that would
// otherwise let a subsequent `docker run --name <same>` collide on the name.
// 10s is generous: typical cleanup completes in <1s, but Docker can stall
// under load. Returns true if removal completed, false on timeout.
export async function waitForRemoval(
  name: string,
  options: { timeoutMs?: number; intervalMs?: number; probe?: (name: string) => Promise<boolean> } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 100
  const probe = options.probe ?? containerExists
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probe(name))) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return !(await probe(name))
}

export function getBun(): { spawn: typeof Bun.spawn } | undefined {
  return (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
}
