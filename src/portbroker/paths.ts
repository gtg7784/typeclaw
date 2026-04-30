import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
  return join(runDir(), 'portbrokerd.sock')
}

export function pidfilePath(): string {
  return join(runDir(), 'portbrokerd.pid')
}

export function lockfilePath(): string {
  return join(runDir(), 'portbrokerd.lock')
}

export function logfilePath(): string {
  return join(logDir(), 'portbrokerd.log')
}

export async function ensureDirs(): Promise<void> {
  await mkdir(runDir(), { recursive: true })
  await mkdir(logDir(), { recursive: true })
}
