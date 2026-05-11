import { isDaemonReachable, send as sendToDaemon } from '@/hostd/client'

import {
  classifyRmStderr,
  containerNameFromCwd,
  defaultDockerExec,
  type DockerExec,
  sanitizeDockerStderr,
  waitForRemoval,
} from './shared'

export type StopPlan = {
  containerName: string
}

export type StopResult = { ok: true; containerName: string; running: boolean } | { ok: false; reason: string }

export type StopOptions = {
  cwd: string
  exec?: DockerExec
}

export async function stop({ cwd, exec = defaultDockerExec }: StopOptions): Promise<StopResult> {
  const { containerName } = planStop(cwd)

  if (await isDaemonReachable()) {
    await sendToDaemon({ kind: 'deregister', containerName })
  }

  try {
    const inspect = await exec(['inspect', '--format', '{{.State.Running}}', containerName], { cwd })
    if (inspect.exitCode !== 0) {
      // `docker inspect` exits non-zero both when the container does not
      // exist AND when it exists but is in a transient state docker cannot
      // inspect (Removal In Progress, Dead, daemon hiccup). Discriminate by
      // stderr — same approach used for `docker rm` below — and attempt a
      // force-remove in the latter case so a corpse holding the name does
      // not collide with the next `docker run --name <same>`.
      if (inspect.stderr.toLowerCase().includes('no such container')) {
        return { ok: true, containerName, running: false }
      }
      const recover = await exec(['rm', '-f', containerName], { cwd })
      if (recover.exitCode !== 0) {
        const kind = classifyRmStderr(recover.stderr)
        if (kind === null) {
          return {
            ok: false,
            reason: `docker inspect failed (${sanitizeDockerStderr(inspect.stderr) || 'no stderr'}) and docker rm -f could not recover: ${sanitizeDockerStderr(recover.stderr) || 'no stderr'}`,
          }
        }
        if (kind === 'in-progress' && !(await waitForRemoval(exec, containerName))) {
          return {
            ok: false,
            reason: `Container ${containerName} is still being removed by docker after 10s.`,
          }
        }
      }
      return { ok: true, containerName, running: false }
    }
    const running = inspect.stdout.trim() === 'true'

    // Only call `docker stop` when the container is actually running. A stopped
    // corpse from a prior crash is left around by design (no `--rm`), and
    // `docker stop` on an exited container would still succeed but emit a
    // noisy warning to stderr — skip it.
    if (running) {
      const stopResult = await exec(['stop', containerName], { cwd })
      if (stopResult.exitCode !== 0) {
        return { ok: false, reason: `docker stop failed: ${sanitizeDockerStderr(stopResult.stderr) || 'no stderr'}` }
      }
    }

    // Containers run without `--rm`, so `docker stop` only stops them — the
    // record stays in `docker ps -a` until we remove it explicitly. Remove now
    // so a subsequent `docker run --name <same>` (e.g. from `typeclaw restart`)
    // does not collide on the name. Use `-f` for symmetry with the start.ts
    // preflight and because `docker stop` occasionally returns exit 0 before
    // the container is fully out of `Running` state on OrbStack under load —
    // bare `docker rm` would then refuse a still-running container. See
    // classifyRmStderr for the benign-failure contract; when 'in-progress',
    // wait for the drain so stop()'s ok-return actually means "name is free"
    // (which compose's restart and any subsequent start() depend on).
    //
    // Same waitForRemoval call on the exit-0 path for the same reason as the
    // start.ts preflight: OrbStack and Docker Desktop under load acknowledge
    // `rm -f` before the daemon has finished draining the removal, so an
    // immediate `docker run --name <same>` (from `typeclaw compose restart`,
    // which fires stop→start sequentially per agent) races the drain and
    // fails with "Conflict. The container name … is already in use by
    // container <ID>". stop()'s contract is that the name is free on return,
    // and the only way to honor that against Docker's async removal is to
    // poll inspect until the container actually disappears.
    const rmResult = await exec(['rm', '-f', containerName], { cwd })
    if (rmResult.exitCode !== 0) {
      const kind = classifyRmStderr(rmResult.stderr)
      if (kind === null) {
        return { ok: false, reason: `docker rm failed: ${sanitizeDockerStderr(rmResult.stderr) || 'no stderr'}` }
      }
      if (kind === 'in-progress' && !(await waitForRemoval(exec, containerName))) {
        return {
          ok: false,
          reason: `Container ${containerName} is still being removed by docker after 10s.`,
        }
      }
    } else if (!(await waitForRemoval(exec, containerName))) {
      return {
        ok: false,
        reason: `Container ${containerName} is still being removed by docker after 10s.`,
      }
    }

    return { ok: true, containerName, running }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planStop(cwd: string): StopPlan {
  return { containerName: containerNameFromCwd(cwd) }
}
