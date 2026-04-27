import { containerExists, containerNameFromCwd, getBun } from './shared'

export type StopPlan = {
  containerName: string
}

export type StopResult = { ok: true; containerName: string; running: boolean } | { ok: false; reason: string }

export async function stop({ cwd }: { cwd: string }): Promise<StopResult> {
  const bun = getBun()
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  const { containerName } = planStop(cwd)

  try {
    if (!(await containerExists(containerName))) {
      return { ok: true, containerName, running: false }
    }

    const dockerStop = bun.spawn({ cmd: ['docker', 'stop', containerName], cwd, stdout: 'pipe', stderr: 'pipe' })
    if ((await dockerStop.exited) !== 0) {
      const stderr = await new Response(dockerStop.stderr).text()
      return { ok: false, reason: `docker stop failed: ${stderr.trim() || 'no stderr'}` }
    }
    // `docker run --rm` auto-removes on stop, so no explicit `docker rm` needed.

    return { ok: true, containerName, running: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planStop(cwd: string): StopPlan {
  return { containerName: containerNameFromCwd(cwd) }
}
