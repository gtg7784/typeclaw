import { isDaemonReachable, send as sendToDaemon } from '@/portbroker/client'

import { containerExists, containerNameFromCwd, getBun, waitForRemoval } from './shared'

export type StopPlan = {
  containerName: string
}

export type StopResult = { ok: true; containerName: string; running: boolean } | { ok: false; reason: string }

export async function stop({ cwd }: { cwd: string }): Promise<StopResult> {
  const bun = getBun()
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  const { containerName } = planStop(cwd)

  if (await isDaemonReachable()) {
    await sendToDaemon({ kind: 'deregister', containerName })
  }

  try {
    if (!(await containerExists(containerName))) {
      return { ok: true, containerName, running: false }
    }

    const dockerStop = bun.spawn({ cmd: ['docker', 'stop', containerName], cwd, stdout: 'pipe', stderr: 'pipe' })
    if ((await dockerStop.exited) !== 0) {
      const stderr = await new Response(dockerStop.stderr).text()
      return { ok: false, reason: `docker stop failed: ${stderr.trim() || 'no stderr'}` }
    }

    // `docker stop` returns when the container's main process exits, but with
    // `--rm` the daemon then removes the container asynchronously. Block until
    // removal completes so a subsequent `docker run --name <same>` (e.g. from
    // `typeclaw restart`) does not race the auto-removal and fail.
    if (!(await waitForRemoval(containerName))) {
      return {
        ok: false,
        reason: `Stopped ${containerName}, but Docker did not remove it within 10s. Try again or run \`docker rm -f ${containerName}\`.`,
      }
    }

    return { ok: true, containerName, running: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planStop(cwd: string): StopPlan {
  return { containerName: containerNameFromCwd(cwd) }
}
