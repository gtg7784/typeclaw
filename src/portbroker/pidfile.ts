import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// `~/.typeclaw/run/` is the host-stage runtime state directory. Tests override
// it via TYPECLAW_HOME so we don't pollute the user's real home.
function homeRoot(): string {
  const override = process.env.TYPECLAW_HOME
  if (override && override.length > 0) return override
  return join(homedir(), '.typeclaw')
}

export function pidfilePath(containerName: string): string {
  return join(homeRoot(), 'run', `${containerName}-portbroker.pid`)
}

export function logfilePath(containerName: string): string {
  return join(homeRoot(), 'log', `${containerName}-portbroker.log`)
}

export async function writePidfile(containerName: string, pid: number): Promise<void> {
  const path = pidfilePath(containerName)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${pid}\n`)
}

// Returns null when the file is missing, malformed, or the PID is stale (no
// such running process). A live PID returns the integer. We treat
// process.kill(pid, 0) as the liveness probe — it's the standard POSIX trick
// and works on macOS and Linux. On EPERM (process exists but owned by
// another user) we still treat it as alive since we cannot SIGTERM it anyway.
export async function readPidfile(containerName: string): Promise<number | null> {
  let raw: string
  try {
    raw = await readFile(pidfilePath(containerName), 'utf8')
  } catch {
    return null
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) return null
  if (!isAlive(pid)) return null
  return pid
}

export async function removePidfile(containerName: string): Promise<void> {
  try {
    await unlink(pidfilePath(containerName))
  } catch {
    return
  }
}

export async function ensureLogDir(containerName: string): Promise<string> {
  const path = logfilePath(containerName)
  await mkdir(dirname(path), { recursive: true })
  return path
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    return false
  }
}
