import { chmod, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Fixed in-container path where the host daemon's run dir is bind-mounted.
// The agent uses this to reach the host daemon (e.g. for the `restart` tool).
// Kept stable so the agent never has to discover the host's `~/.typeclaw`
// location at runtime.
const CONTAINER_HOST_RUN_DIR = '/run/typeclaw-host'
const SOCKET_FILE = 'hostd.sock'
const REGISTRATIONS_DIR = 'registrations'
const KEYS_DIR = 'keys'

// Defense-in-depth: containerName arrives from RPC payloads (some of which
// originate inside the container). Docker already forbids slashes and most
// punctuation in names, but we don't want to trust the wire to enforce that.
// The character class mirrors Docker's container-naming rules; anything
// else is rejected so a malicious payload can't escape registrationsDir().
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

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

export function registrationsDir(): string {
  return join(runDir(), REGISTRATIONS_DIR)
}

export function keysDir(): string {
  return join(homeRoot(), KEYS_DIR)
}

// Throws on any name that could traverse out of registrationsDir() or
// confuse the filesystem. Caller's responsibility to handle the error;
// don't catch-and-ignore — an invalid name is a protocol violation.
export function registrationFilePath(containerName: string): string {
  if (!SAFE_NAME.test(containerName)) {
    throw new Error(`invalid container name for registration file: ${JSON.stringify(containerName)}`)
  }
  return join(registrationsDir(), `${containerName}.json`)
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
  await mkdir(registrationsDir(), { recursive: true })
  await mkdir(keysDir(), { recursive: true })
  await chmod(runDir(), 0o700).catch(() => {})
  await chmod(logDir(), 0o700).catch(() => {})
  await chmod(registrationsDir(), 0o700).catch(() => {})
  await chmod(keysDir(), 0o700).catch(() => {})
}
