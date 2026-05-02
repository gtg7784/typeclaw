import { existsSync } from 'node:fs'
import { open, readFile, unlink, writeFile } from 'node:fs/promises'

import { isDaemonReachable, send } from './client'
import { ensureDirs, lockfilePath, logfilePath, pidfilePath, socketPath } from './paths'
import type { VersionResult } from './protocol'
import { computeSourceVersion, resolveSrcRoot, UNVERSIONED_SENTINEL } from './version'

export type EnsureDaemonOptions = {
  cliEntry: string
  spawnTimeoutMs?: number
  // Test seam: tests inject a deterministic version probe + respawn so the
  // unit test can exercise the drift path without spawning a real daemon.
  expectedVersion?: string
}

export type EnsureDaemonResult =
  | { ok: true; pid: number; spawned: boolean; respawned: boolean }
  | { ok: false; reason: string }

const DEFAULT_SPAWN_TIMEOUT_MS = 5_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  if (await isDaemonReachable()) {
    const expected = opts.expectedVersion ?? (await deriveExpectedVersion(opts.cliEntry))
    if (await daemonVersionMatches(expected)) {
      return { ok: true, pid: await readPidQuiet(), spawned: false, respawned: false }
    }
    const shutdownOk = await requestShutdownAndWait()
    if (!shutdownOk) {
      return { ok: false, reason: 'daemon version drifted but shutdown request did not complete' }
    }
    await ensureDirs()
    const respawn = await ensureDaemonWithRetry(opts, 1)
    if (!respawn.ok) return respawn
    return { ...respawn, respawned: true }
  }

  await ensureDirs()
  const result = await ensureDaemonWithRetry(opts, 1)
  if (!result.ok) return result
  return { ...result, respawned: false }
}

async function deriveExpectedVersion(cliEntry: string): Promise<string> {
  const srcRoot = resolveSrcRoot(cliEntry)
  if (srcRoot === null) return UNVERSIONED_SENTINEL
  return computeSourceVersion({ srcRoot })
}

// A `version` reply that doesn't deserialize cleanly (e.g. a pre-feature
// daemon that doesn't recognize the kind) is treated as a mismatch. Same for
// any non-ok response. Conservative: it's safer to over-respawn than to keep
// running stale code.
async function daemonVersionMatches(expected: string): Promise<boolean> {
  const reply = await send({ kind: 'version' }, { timeoutMs: 1_000 })
  if (!reply.ok) return false
  const result = reply.result as VersionResult | undefined
  if (!result || typeof result.version !== 'string') return false
  return result.version === expected
}

async function requestShutdownAndWait(): Promise<boolean> {
  const reply = await send({ kind: 'shutdown' }, { timeoutMs: 1_000 })
  if (!reply.ok) return false
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!existsSync(socketPath())) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

type SpawnAttemptResult = { ok: true; pid: number; spawned: boolean } | { ok: false; reason: string }

async function ensureDaemonWithRetry(opts: EnsureDaemonOptions, retriesLeft: number): Promise<SpawnAttemptResult> {
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

async function spawnDaemonDetached(opts: EnsureDaemonOptions): Promise<SpawnAttemptResult> {
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
      cmd: [process.execPath, opts.cliEntry, '_hostd'],
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
