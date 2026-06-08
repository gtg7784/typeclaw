import { SandboxUnavailableError } from './errors'

// Cached because the binary cannot appear or disappear during a single
// process lifetime, and a probe per bash call is wasted work. Keyed by the
// resolved bwrap path so a test (or a consumer pinning a non-default path)
// re-probes instead of reading another path's cached result.
const availabilityCache = new Map<string, boolean>()
// In-flight dedup: bash calls run concurrently (subagents, cron, parallel
// tool calls), so without this two calls racing before the cache is populated
// would each spawn a probe. The promise is cleared on settle so a probe that
// was aborted (not "unavailable", just cancelled) does not poison the next
// caller — the next call re-probes from scratch. Mirrors the channels
// membership-cache in-flight pattern.
const availabilityInFlight = new Map<string, Promise<boolean>>()

export async function ensureBwrapAvailable(options?: { bwrapPath?: string }): Promise<void> {
  const bwrap = options?.bwrapPath ?? 'bwrap'
  const cached = availabilityCache.get(bwrap)
  if (cached === true) return
  if (cached === false) throw new SandboxUnavailableError()

  const available = await dedupedProbe(bwrap)
  if (!available) throw new SandboxUnavailableError()
}

function dedupedProbe(bwrap: string): Promise<boolean> {
  const existing = availabilityInFlight.get(bwrap)
  if (existing !== undefined) return existing

  const promise = probe(bwrap)
    .then((available) => {
      // Cache unconditionally, including false: a genuinely missing bwrap is a
      // process-global fact, so the negative must stick rather than re-probe on
      // every bash call. (No per-caller signal here — see canMountRealProc.)
      availabilityCache.set(bwrap, available)
      return available
    })
    .finally(() => {
      availabilityInFlight.delete(bwrap)
    })
  availabilityInFlight.set(bwrap, promise)
  return promise
}

async function probe(bwrap: string): Promise<boolean> {
  // Bun.spawn throws synchronously with ENOENT when the binary is not on
  // PATH, rather than resolving with a non-zero exit code — so the
  // "not installed" case lands in the catch, not in proc.exitCode.
  try {
    const proc = Bun.spawn([bwrap, '--version'], { stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

export function _resetBwrapAvailabilityCacheForTests(): void {
  availabilityCache.clear()
  availabilityInFlight.clear()
}

// The 'real-proc' sandbox strategy prefixes bwrap with `unshare --pid --fork
// --mount --mount-proc`, which mounts a fresh procfs in a new PID namespace.
// That mount needs REAL CAP_SYS_ADMIN. `typeclaw start` grants the container
// `--cap-add=SYS_ADMIN` when sandbox.realProc is on, but the grant is a no-op
// on runtimes that virtualize or strip caps: rootless Docker (userns-capped
// caps), gVisor/runsc (caps never reach the host kernel), Docker Desktop
// Enhanced Container Isolation (intercepts mount), and AppArmor-enforcing
// hosts (Ubuntu 24.04+ restricts unprivileged userns even with the cap). On
// those the `unshare` fails fast with "Operation not permitted" (exit != 0)
// before bwrap runs. Probing once at the first sandboxed bash call lets the
// consumer fall back to the '--tmpfs /proc' strategy instead of failing every
// low-trust bash call — restoring the pre-realProc behavior on unsupported
// hosts (external-package execution still won't work there, exactly as before).
let realProcProbeResult: boolean | undefined
// In-flight dedup for the real-proc probe, same rationale as bwrap above:
// concurrent first bash calls would otherwise each spawn `unshare`. A single
// nullable promise suffices (no key — there is one probe), cleared on settle.
//
// Deliberately NOT abortable. The answer ("can THIS container mount a fresh
// procfs?") is a process-global capability fact, not a per-request operation —
// it does not vary with any one bash call's lifecycle. Threading a caller's
// AbortSignal here is a category error: a deduped joiner would let the first
// caller's abort decide a shared fact for everyone waiting on it. The payload
// (`/bin/true`) exits in milliseconds and the result is cached for the process,
// so cancellation buys nothing. If a supported environment ever made this probe
// slow, add an INTERNAL timeout (the result is still global), never a caller
// signal.
let realProcProbeInFlight: Promise<boolean> | undefined

export function canMountRealProc(): Promise<boolean> {
  if (realProcProbeResult !== undefined) return Promise.resolve(realProcProbeResult)
  if (realProcProbeInFlight !== undefined) return realProcProbeInFlight

  const promise = probeRealProc()
    .then((canMount) => {
      realProcProbeResult = canMount
      return canMount
    })
    .finally(() => {
      realProcProbeInFlight = undefined
    })
  realProcProbeInFlight = promise
  return promise
}

async function probeRealProc(): Promise<boolean> {
  // `/bin/true` is the cheapest possible payload: the probe only needs to learn
  // whether the kernel lets us create the PID+mount namespaces and mount procfs
  // into them. Bun.spawn throws ENOENT if `unshare` is missing (it is in
  // util-linux, baseline) — that lands in the catch as "cannot do real-proc".
  try {
    const proc = Bun.spawn(['unshare', '--pid', '--fork', '--mount', '--mount-proc', '--', '/bin/true'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

export function _resetRealProcProbeCacheForTests(): void {
  realProcProbeResult = undefined
  realProcProbeInFlight = undefined
}

// The 'proc-bind' strategy (build.ts) does `bwrap --unshare-all ... --ro-bind
// /proc /proc`: it binds the container's already-real procfs with NO unshare
// --mount-proc and NO CAP_SYS_ADMIN, so it works where 'real-proc' is rejected
// (OrbStack). Its security rests entirely on the kernel BLOCKING cross-userns
// reads of /proc/<agent>/environ — the FIREWORKS_API_KEY / GH_TOKEN surface —
// because bwrap's --unshare-all puts the sandbox in a CHILD user namespace. That
// block is a kernel fact on every mainstream host, but the consumer must never
// assume it: a misconfigured runtime that preserves parent-userns creds, or a
// future bwrap flag change, would turn this strategy into a secret leak. So we
// PROBE it directly before ever selecting it — plant a real secret in a sibling
// process's env and assert the sandbox cannot read it back.
let procBindProbeResult: boolean | undefined
// Same in-flight dedup + process-global caching rationale as canMountRealProc:
// the answer is a per-container capability fact, so concurrent first callers
// share one probe and the result sticks. Not abortable (see canMountRealProc).
let procBindProbeInFlight: Promise<boolean> | undefined

export function canBindProcSafely(options?: { bwrapPath?: string }): Promise<boolean> {
  if (procBindProbeResult !== undefined) return Promise.resolve(procBindProbeResult)
  if (procBindProbeInFlight !== undefined) return procBindProbeInFlight

  const promise = probeProcBind(options?.bwrapPath ?? 'bwrap')
    .then((safe) => {
      procBindProbeResult = safe
      return safe
    })
    .finally(() => {
      procBindProbeInFlight = undefined
    })
  procBindProbeInFlight = promise
  return promise
}

const PROC_BIND_PROBE_SECRET = 'TYPECLAW_PROCBIND_PROBE_SECRET'

async function probeProcBind(bwrap: string): Promise<boolean> {
  // The sentinel must model the REAL threat geometry: the agent runtime holds
  // the secret in its env and lives in the PARENT user namespace, while the
  // sandbox is a child userns. So spawn the sentinel as a plain sibling (parent
  // userns, same real uid as the agent runtime) that just sleeps holding the
  // secret, then enter the EXACT proc-bind bwrap shape and prove the sandbox
  // cannot read it. A weaker model (sentinel inside the same userns as the probe
  // bash) would falsely pass.
  let sentinel: Bun.Subprocess | undefined
  try {
    // `env -i` so the sentinel carries ONLY the marker, never the parent's real
    // FIREWORKS_API_KEY/GH_TOKEN — the probe must not itself plant a real secret,
    // independent of Bun.spawn's env merge/replace semantics. `sleep 300` is long
    // enough that the sentinel cannot exit mid-probe and turn a "permission
    // denied" assertion into a "no such process" false pass (see below).
    sentinel = Bun.spawn(['/usr/bin/env', '-i', `${PROC_BIND_PROBE_SECRET}=leaked`, '/bin/sleep', '300'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const sentinelPid = sentinel.pid

    if (sentinelPid === undefined) return false
    // Two-sided proof that the in-sandbox block is the USERNS boundary and
    // nothing else. From the PARENT (this process — container root, parent
    // userns, same uid as the sentinel) the sentinel's environ MUST be readable:
    // that establishes the sentinel is dumpable and same-uid, so the ONLY thing
    // that can deny the read from inside the sandbox is the child-userns boundary
    // (rules out a false "blocked" caused by an unrelated dumpable=0 / uid
    // mismatch). If the parent itself can't read it, the sentinel setup is
    // unsound and we cannot conclude anything — fail closed.
    if (!(await parentCanRead(`/proc/${sentinelPid}/environ`))) return false

    // In-sandbox, the assertion must prove the block holds for the RIGHT REASON.
    // A naive `cat environ && exit 1` passes on BOTH "permission denied" (EACCES,
    // the real userns block — SAFE) and "no such process" (ESRCH, the sentinel
    // died — proves NOTHING); on a host that actually leaks, a sentinel that
    // exited early would false-pass. So the script positively verifies, in order:
    //   1. self /proc/self/{fd,maps} readable — the property that makes bunx work
    //   2. the sentinel is ALIVE and visible — /proc/<pid>/status readable, so a
    //      later environ failure cannot be ESRCH (a dead pid fails here)
    //   3. environ + maps reads fail with EACCES SPECIFICALLY (stderr matches
    //      "Permission denied"), NOT ESRCH and NOT a successful read. Combined
    //      with the parent-readable check above, an EACCES here can only be the
    //      cross-userns block. environ is the API-key surface; maps is the
    //      secondary mem-layout surface.
    // `kill -0` and `readlink ns/user` are deliberately NOT asserted: the
    // busybox/dash `kill` builtin exits 1 with no stderr for BOTH EPERM and
    // ESRCH, and `readlink` prints nothing on EACCES — neither can distinguish
    // the safe case from a dead pid, so asserting them would be theater. The
    // load-bearing guarantee is (3): the secret surface is unreadable, for the
    // reason proven by the parent-readable bracket.
    // Any deviation exits non-zero → canBindProcSafely() returns false → the
    // resolver falls back to tmpfs. `--ro-bind /proc /proc` with no
    // /proc/self/exe symlink mirrors build.ts's proc-bind branch exactly.
    const deniedRead = (path: string): string => `cat ${path} 2>&1 >/dev/null | grep -q 'Permission denied' || exit 1`
    const script = [
      `test -r /proc/self/fd || exit 1`,
      `test -r /proc/self/maps || exit 1`,
      `test -r /proc/${sentinelPid}/status || exit 1`,
      deniedRead(`/proc/${sentinelPid}/environ`),
      deniedRead(`/proc/${sentinelPid}/maps`),
      `exit 0`,
    ].join('; ')
    const proc = Bun.spawn(
      [
        bwrap,
        '--unshare-all',
        '--clearenv',
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind-try',
        '/bin',
        '/bin',
        '--ro-bind-try',
        '/lib',
        '/lib',
        '--ro-bind-try',
        '/lib64',
        '/lib64',
        '--ro-bind',
        '/proc',
        '/proc',
        '--',
        '/bin/sh',
        '-c',
        script,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    await proc.exited
    if (proc.exitCode !== 0) return false
    // Liveness re-check from the PARENT, where the sentinel IS readable: if it
    // died during the probe, the in-sandbox assertions that depended on its pid
    // resolving are void, so fail closed rather than trust them.
    return !sentinel.killed && sentinel.exitCode === null
  } catch {
    return false
  } finally {
    sentinel?.kill()
  }
}

async function parentCanRead(path: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['cat', path], { stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

export function _resetProcBindProbeCacheForTests(): void {
  procBindProbeResult = undefined
  procBindProbeInFlight = undefined
}

// The bun binary this process runs as (process.execPath). build.ts re-exposes
// it at /proc/self/exe over the masked /proc so sandboxed package runners can
// self-locate. This is correct ONLY in the bun-centric container: the base
// image (oven/bun:1-slim) ships no real node — `node` is a bun symlink and
// bunx/npx/pnpx all resolve to bun (Bun's fake-node model), so every runtime
// reading /proc/self/exe IS bun. A real node binary would self-locate to the
// wrong ELF here; if node is ever added to the image this must resolve the
// actual interpreter instead.
export function resolveProcSelfExe(): string {
  return process.execPath
}
