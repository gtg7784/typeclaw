import { chmod, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Fixed in-container path where the host daemon's run dir is bind-mounted.
// The agent uses this to reach the host daemon (e.g. for the `restart` tool).
// Kept stable so the agent never has to discover the host's `~/.typeclaw`
// location at runtime.
const CONTAINER_HOST_RUN_DIR = '/run/typeclaw-host'
const SOCKET_FILE = 'hostd.sock'

export function homeRoot(): string {
  const override = process.env.TYPECLAW_HOME
  if (override && override.length > 0) return override
  return join(homedir(), '.typeclaw')
}

export function runDir(): string {
  return join(homeRoot(), 'run')
}

export function logDir(): string {
  return join(homeRoot(), 'log')
}

export function socketPath(): string {
  return join(runDir(), SOCKET_FILE)
}

export function pidfilePath(): string {
  return join(runDir(), 'hostd.pid')
}

export function lockfilePath(): string {
  return join(runDir(), 'hostd.lock')
}

export function logfilePath(): string {
  return join(logDir(), 'hostd.log')
}

// In-container path to the same socket the host daemon listens on. The
// container-stage agent tool dials this path; the host bind-mounts the host
// run dir at CONTAINER_HOST_RUN_DIR so the socket is reachable.
export function containerSocketPath(): string {
  return join(CONTAINER_HOST_RUN_DIR, SOCKET_FILE)
}

export function containerHostRunDir(): string {
  return CONTAINER_HOST_RUN_DIR
}

export async function ensureDirs(): Promise<void> {
  await mkdir(runDir(), { recursive: true })
  await mkdir(logDir(), { recursive: true })
  await chmod(runDir(), 0o700).catch(() => {})
  await chmod(logDir(), 0o700).catch(() => {})
}
