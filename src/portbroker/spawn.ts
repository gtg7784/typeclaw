import { open } from 'node:fs/promises'

import { ensureLogDir, readPidfile, removePidfile, writePidfile } from './pidfile'

export type SpawnBrokerOptions = {
  cwd: string
  containerName: string
  brokerEntry: string
}

export type SpawnBrokerResult = { ok: true; pid: number; alreadyRunning: boolean } | { ok: false; reason: string }

export async function spawnBrokerDetached(opts: SpawnBrokerOptions): Promise<SpawnBrokerResult> {
  const existing = await readPidfile(opts.containerName)
  if (existing !== null) {
    return { ok: true, pid: existing, alreadyRunning: true }
  }

  let logFd: number
  try {
    const path = await ensureLogDir(opts.containerName)
    const handle = await open(path, 'a')
    logFd = handle.fd
  } catch (error) {
    return { ok: false, reason: `failed to open broker log: ${stringifyError(error)}` }
  }

  const proc = Bun.spawn({
    cmd: [process.execPath, opts.brokerEntry, '_portbroker', '--container', opts.containerName, '--cwd', opts.cwd],
    stdin: 'ignore',
    stdout: logFd,
    stderr: logFd,
    env: { ...process.env, TYPECLAW_PORTBROKER_CHILD: '1' },
  })

  proc.unref()
  await writePidfile(opts.containerName, proc.pid)
  return { ok: true, pid: proc.pid, alreadyRunning: false }
}

export type StopBrokerOptions = {
  containerName: string
  signal?: NodeJS.Signals
}

export type StopBrokerResult = { ok: true; killed: boolean }

export async function stopBrokerDetached(opts: StopBrokerOptions): Promise<StopBrokerResult> {
  const pid = await readPidfile(opts.containerName)
  if (pid === null) {
    await removePidfile(opts.containerName)
    return { ok: true, killed: false }
  }
  try {
    process.kill(pid, opts.signal ?? 'SIGTERM')
  } catch {}
  await removePidfile(opts.containerName)
  return { ok: true, killed: true }
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
