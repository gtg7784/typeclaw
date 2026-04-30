import { containerExists, containerNameFromCwd, getBun } from './shared'

export type LogsPlan = {
  containerName: string
  follow: boolean
}

export type LogsResult = { ok: true; containerName: string; exitCode: number } | { ok: false; reason: string }

export async function logs({ cwd, follow }: { cwd: string; follow: boolean }): Promise<LogsResult> {
  const bun = getBun()
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  const { containerName } = planLogs(cwd, { follow })

  try {
    if (!(await containerExists(containerName))) {
      return { ok: false, reason: `Container ${containerName} not found. Run \`typeclaw start\` first.` }
    }

    const cmd = ['docker', 'logs']
    if (follow) cmd.push('-f')
    cmd.push(containerName)

    // Inherit stdio so logs stream live and Ctrl+C reaches `docker logs`,
    // which exits cleanly on SIGINT in follow mode.
    const proc = bun.spawn({ cmd, cwd, stdout: 'inherit', stderr: 'inherit' })
    const exitCode = await proc.exited
    return { ok: true, containerName, exitCode }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planLogs(cwd: string, { follow }: { follow: boolean }): LogsPlan {
  return { containerName: containerNameFromCwd(cwd), follow }
}
