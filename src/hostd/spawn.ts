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
  return ensureDaemonWithRetry(opts, 1)
}

async function ensureDaemonWithRetry(opts: EnsureDaemonOptions, retriesLeft: number): Promise<EnsureDaemonResult> {
  const lock = await acquireLockOrWait(opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS)
  if (lock.kind === 'daemon-reachable') {
    return { ok: true, pid: await readPidQuiet(), spawned: false }
  }
  if (lock.kind === 'stale-lock-cleared') {
    if (retriesLeft > 0) return ensureDaemonWithRetry(opts, retriesLeft - 1)
    return { ok: false, reason: 'stale lockfile cleared but retry budget exhausted' }
  }
  if (lock.kind === 'timeout') {
    return { ok: false, reason: lock.reason }
  }

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
  // Bun.spawn() with `stdout: <number>` consumes the file descriptor by
  // dup()-ing it into the child; the parent's handle remains valid until we
  // close it. Closing too early would race the dup. We hold the FileHandle
  // open across spawn() and close it only after the child has been launched.
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(logfilePath(), 'a')
  } catch (error) {
    return { ok: false, reason: `failed to open daemon log: ${stringify(error)}` }
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn({
      cmd: [process.execPath, opts.brokerEntry, '_hostd'],
      stdin: 'ignore',
      stdout: handle.fd,
      stderr: handle.fd,
      env: { ...process.env },
    })
  } catch (error) {
    handle.close().catch(() => {})
    return { ok: false, reason: `failed to spawn daemon: ${stringify(error)}` }
  }
  proc.unref()
  handle.close().catch(() => {})

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

  // Daemon failed to come up. Reap the orphan and clean the pidfile so the
  // next ensureDaemon() doesn't observe a dangling pidfile pointing at our
  // dead child.
  try {
    proc.kill('SIGTERM')
  } catch {}
  try {
    const raw = await readFile(pidfilePath(), 'utf8').catch(() => '')
    if (raw.trim() === String(proc.pid)) await unlink(pidfilePath())
  } catch {}
  return { ok: false, reason: 'daemon spawned but did not become reachable' }
}

type LockToken = { path: string }
type LockResult =
  | { kind: 'acquired'; token: LockToken }
  | { kind: 'daemon-reachable' }
  | { kind: 'stale-lock-cleared' }
  | { kind: 'timeout'; reason: string }

async function acquireLockOrWait(timeoutMs: number): Promise<LockResult> {
  const path = lockfilePath()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const handle = await open(path, 'wx')
      await handle.write(`${process.pid}\n`)
      await handle.close()
      return { kind: 'acquired', token: { path } }
    } catch {
      if (await isDaemonReachable()) return { kind: 'daemon-reachable' }
      await sleep(POLL_INTERVAL_MS)
    }
  }
  // Lock held by something that never finished. Clear it so the caller can
  // retry once. Rare in practice (only happens if a previous ensureDaemon
  // process was killed mid-spawn).
  try {
    await unlink(path)
  } catch {}
  return { kind: 'stale-lock-cleared' }
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
