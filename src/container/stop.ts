import { isDaemonReachable, send as sendToDaemon } from '@/hostd/client'

import { containerNameFromCwd, defaultDockerExec, type DockerExec, isBenignRmStderr } from './shared'

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
      if (recover.exitCode !== 0 && !isBenignRmStderr(recover.stderr)) {
        return {
          ok: false,
          reason: `docker inspect failed (${inspect.stderr.trim() || 'no stderr'}) and docker rm -f could not recover: ${recover.stderr.trim() || 'no stderr'}`,
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
        return { ok: false, reason: `docker stop failed: ${stopResult.stderr.trim() || 'no stderr'}` }
      }
    }

    // Containers run without `--rm`, so `docker stop` only stops them — the
    // record stays in `docker ps -a` until we remove it explicitly. Remove now
    // so a subsequent `docker run --name <same>` (e.g. from `typeclaw restart`)
    // does not collide on the name. Use `-f` for symmetry with the start.ts
    // preflight and because `docker stop` occasionally returns exit 0 before
    // the container is fully out of `Running` state on OrbStack under load —
    // bare `docker rm` would then refuse a still-running container. Treat
    // benign rm failures as success — see isBenignRmStderr for the contract.
    const rmResult = await exec(['rm', '-f', containerName], { cwd })
    if (rmResult.exitCode !== 0 && !isBenignRmStderr(rmResult.stderr)) {
      return { ok: false, reason: `docker rm failed: ${rmResult.stderr.trim() || 'no stderr'}` }
    }

    return { ok: true, containerName, running }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planStop(cwd: string): StopPlan {
  return { containerName: containerNameFromCwd(cwd) }
}
