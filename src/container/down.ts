import { containerExists, containerNameFromCwd, getBun } from './shared'

export type DownPlan = {
  containerName: string
}

export type DownResult = { ok: true; containerName: string; running: boolean } | { ok: false; reason: string }

export async function down({ cwd }: { cwd: string }): Promise<DownResult> {
  const bun = getBun()
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  const { containerName } = planDown(cwd)

  try {
    if (!(await containerExists(containerName))) {
      return { ok: true, containerName, running: false }
    }

    const stop = bun.spawn({ cmd: ['docker', 'stop', containerName], cwd, stdout: 'pipe', stderr: 'pipe' })
    if ((await stop.exited) !== 0) {
      const stderr = await new Response(stop.stderr).text()
      return { ok: false, reason: `docker stop failed: ${stderr.trim() || 'no stderr'}` }
    }
    // `docker run --rm` auto-removes on stop, so no explicit `docker rm` needed.

    return { ok: true, containerName, running: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planDown(cwd: string): DownPlan {
  return { containerName: containerNameFromCwd(cwd) }
}
