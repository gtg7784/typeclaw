import { open, readFile, unlink, writeFile } from 'node:fs/promises'

import { isDaemonReachable } from './client'
import { ensureDirs, lockfilePath, logfilePath, pidfilePath } from './paths'

export type EnsureDaemonOptions = {
  brokerEntry: string
  spawnTimeoutMs?: number
}

export type EnsureDaemonResult = { ok: true; pid: number; spawned: boolean } | { ok: false; reason: string }

const DEFAULT_SPAWN_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  if (await isDaemonReachable()) {
    return { ok: true, pid: await readPidQuiet(), spawned: false }
  }

  await ensureDirs()
  const lock = await acquireLockOrWait(opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS)
  if (!lock.ok) return { ok: false, reason: lock.reason }

  try {
    if (await isDaemonReachable()) {
      return { ok: true, pid: await readPidQuiet(), spawned: false }
    }
    return await spawnDaemonDetached(opts)
  } finally {
    await releaseLock(lock.token)
  }
}

async function spawnDaemonDetached(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  let logFd: number
  try {
    const handle = await open(logfilePath(), 'a')
    logFd = handle.fd
    handle.close().catch(() => {})
  } catch (error) {
    return { ok: false, reason: `failed to open daemon log: ${stringify(error)}` }
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn({
      cmd: [process.execPath, opts.brokerEntry, '_portbrokerd'],
      stdin: 'ignore',
      stdout: logFd,
      stderr: logFd,
      env: { ...process.env },
    })
  } catch (error) {
    return { ok: false, reason: `failed to spawn daemon: ${stringify(error)}` }
  }
  proc.unref()

  try {
    await writeFile(pidfilePath(), `${proc.pid}\n`)
  } catch (error) {
    try {
      proc.kill('SIGTERM')
    } catch {}
    return { ok: false, reason: `failed to write daemon pidfile: ${stringify(error)}` }
  }

  const deadline = Date.now() + (opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (await isDaemonReachable()) return { ok: true, pid: proc.pid, spawned: true }
    await sleep(POLL_INTERVAL_MS)
  }
  return { ok: false, reason: 'daemon spawned but did not become reachable' }
}

type LockToken = { path: string }

async function acquireLockOrWait(
  timeoutMs: number,
): Promise<{ ok: true; token: LockToken } | { ok: false; reason: string }> {
  const path = lockfilePath()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const handle = await open(path, 'wx')
      await handle.write(`${process.pid}\n`)
      await handle.close()
      return { ok: true, token: { path } }
    } catch {
      if (await isDaemonReachable()) {
        return { ok: false, reason: 'another caller already started the daemon' }
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }
  try {
    await unlink(path)
  } catch {}
  return { ok: false, reason: 'lockfile contention timeout' }
}

async function releaseLock(token: LockToken): Promise<void> {
  try {
    await unlink(token.path)
  } catch {}
}

async function readPidQuiet(): Promise<number> {
  try {
    const raw = await readFile(pidfilePath(), 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(pid) ? pid : 0
  } catch {
    return 0
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
