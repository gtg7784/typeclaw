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
// Keyed by resolved bwrapPath, like ensureBwrapAvailable: the safety answer is a
// fact about a SPECIFIC bwrap binary, so a caller pinning a non-default path
// (tests, or a future deployment) must re-probe rather than inherit the default
// binary's result. In-flight dedup for the same reason as canMountRealProc:
// concurrent first callers for one path share a single probe. Both cached
// process-globally (the answer is a per-container capability fact). Not abortable
// (see canMountRealProc).
const procBindProbeCache = new Map<string, boolean>()
const procBindProbeInFlight = new Map<string, Promise<boolean>>()

// `safe` is the answer; `cacheable` is false for INCONCLUSIVE outcomes (a probe
// timeout under load, or the sentinel dying mid-probe). Those are transient
// failure modes, not capability facts, so caching their `safe=false` would
// PERMANENTLY disable proc-bind for the process — a single slow first bash call
// would silently break every later bunx until container restart (the exact
// "works after restart" symptom this whole fix exists to kill). Only a probe that
// ran to a verdict (definitively safe OR definitively leaking) is cached.
type ProcBindProbe = { safe: boolean; cacheable: boolean }

export function canBindProcSafely(options?: { bwrapPath?: string }): Promise<boolean> {
  const bwrap = options?.bwrapPath ?? 'bwrap'
  const cached = procBindProbeCache.get(bwrap)
  if (cached !== undefined) return Promise.resolve(cached)
  const existing = procBindProbeInFlight.get(bwrap)
  if (existing !== undefined) return existing

  const promise = probeProcBind(bwrap)
    .then(({ safe, cacheable }) => {
      if (cacheable) procBindProbeCache.set(bwrap, safe)
      return safe
    })
    .finally(() => {
      procBindProbeInFlight.delete(bwrap)
    })
  procBindProbeInFlight.set(bwrap, promise)
  return promise
}

const PROC_BIND_PROBE_SECRET = 'TYPECLAW_PROCBIND_PROBE_SECRET'

const INCONCLUSIVE: ProcBindProbe = { safe: false, cacheable: false }

async function probeProcBind(bwrap: string): Promise<ProcBindProbe> {
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
    // independent of Bun.spawn's env merge/replace semantics. `sleep 30` outlives
    // the sub-second probe by a wide margin (so it cannot exit mid-probe and let
    // a post-exit ESRCH masquerade as the EACCES block), yet is short enough to
    // self-reap within seconds if cleanup ever fails to fire .kill().
    sentinel = Bun.spawn(['/usr/bin/env', '-i', `${PROC_BIND_PROBE_SECRET}=leaked`, '/bin/sleep', '30'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const sentinelPid = sentinel.pid

    // No pid / a failed sentinel setup is a transient local failure, not a
    // capability verdict — inconclusive, so it is not cached.
    if (sentinelPid === undefined) return INCONCLUSIVE
    // Two-sided proof that the in-sandbox block is the USERNS boundary and
    // nothing else. From the PARENT (this process — container root, parent
    // userns, same uid as the sentinel) the sentinel's environ MUST contain the
    // marker: that proves the sentinel is dumpable, same-uid, AND that this pid is
    // OUR sentinel (not a reused pid), so the ONLY thing that can deny the read
    // from inside the sandbox is the child-userns boundary (rules out a false
    // "blocked" from dumpable=0 / uid mismatch). If the parent can't read the
    // marker, the sentinel setup is unsound — inconclusive, fail closed, no cache.
    if (!(await parentReadsSentinelMarker(sentinelPid))) return INCONCLUSIVE

    const proc = Bun.spawn(
      [
        bwrap,
        '--unshare-all',
        '--clearenv',
        '--ro-bind',
        '/usr',
        '/usr',
        '--dev',
        '/dev',
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
        buildProcBindProbeScript(sentinelPid),
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    // Resolve the probe against three outcomes:
    //   - the bwrap probe exits → use its verdict (cacheable)
    //   - the sentinel exits FIRST → the in-sandbox open-failures could now be
    //     ESRCH (pid gone), so the verdict is void → inconclusive
    //   - a hung bwrap (a wedged runtime) → time out, so a stuck probe never
    //     stalls the first low-trust bash call → inconclusive
    // The timeout is a setTimeout cleared in finally: an abandoned Bun.sleep timer
    // keeps Bun's event loop alive for the full delay (verified: ~5s hang on
    // process drain after the first bash call), so it MUST be cancelled once the
    // race settles.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        proc.exited.then(() => 'probe' as const),
        sentinel.exited.then(() => 'sentinel-died' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), PROC_BIND_PROBE_TIMEOUT_MS)
        }),
      ])
      if (outcome !== 'probe') {
        // SIGKILL + await reaping so a wedged probe leaves no zombie; swallow any
        // error so cleanup never throws out of the probe.
        proc.kill('SIGKILL')
        await proc.exited.catch(() => {})
        return INCONCLUSIVE
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    // Interpret the verdict by the SPECIFIC exit code the script chose, never by
    // "non-zero" — a non-zero exit also covers script setup failures (a bwrap that
    // started but couldn't read /proc/self/fd), bwrap startup failures (missing
    // lib, transient mount EBUSY → bwrap's own exit), and an external SIGKILL.
    // Caching any of those transient failures as a definitive safe=false would
    // PERMANENTLY disable proc-bind — the same cache-poisoning class as the
    // timeout bug. So only the script's two designated codes are cacheable:
    // PROC_BIND_SAFE (clean run, every open blocked) and PROC_BIND_LEAK (an open
    // SUCCEEDED — a real leak). Setup failures use PROC_BIND_SETUP_FAILED, and any
    // other code (bwrap startup, signals, 127) is treated as inconclusive.
    if (proc.exitCode === PROC_BIND_LEAK) return { safe: false, cacheable: true }
    if (proc.exitCode !== PROC_BIND_SAFE) return INCONCLUSIVE
    // Final liveness: the in-sandbox blocked-open assertions are only meaningful
    // if the sentinel was alive throughout. Re-read its MARKER from the PARENT —
    // success proves the pid still resolves to OUR live sentinel, so the in-sandbox
    // open-failures were EACCES, not a post-exit ESRCH (or a reused pid).
    // `sentinel.killed`/`exitCode` only report whether Bun signalled it, not
    // kernel liveness, so this marker re-read is the stronger postcondition. A
    // failure here means the sentinel vanished mid-probe → inconclusive.
    if (!(await parentReadsSentinelMarker(sentinelPid))) return INCONCLUSIVE
    return { safe: true, cacheable: true }
  } catch {
    return INCONCLUSIVE
  } finally {
    try {
      sentinel?.kill()
    } catch {
      // killing an already-exited sentinel can throw on some runtimes; cleanup
      // must never propagate out of the probe.
    }
  }
}

// Cap on the in-sandbox bwrap probe so a wedged runtime cannot stall the first
// low-trust bash call. The probe normally completes in a few ms; this is a
// generous ceiling, not a tuning knob.
const PROC_BIND_PROBE_TIMEOUT_MS = 5_000

// Designated probe-script exit codes. ONLY these two are a cacheable verdict;
// every other code (a setup failure, bwrap startup failure, a signal, 127, …) is
// inconclusive and must NOT be cached — see the exit-code interpretation in
// probeProcBind. Chosen well clear of the shell's own conventional codes (1, 2,
// 126, 127, 128+n) so a setup/bwrap/signal failure can never be mistaken for the
// safe or leak verdict.
const PROC_BIND_SAFE = 0
const PROC_BIND_LEAK = 10
const PROC_BIND_SETUP_FAILED = 20

// The in-sandbox assertion, built as a pure function so a unit test can pin its
// shape (the integration behavior needs a Linux container + bwrap, unrunnable in
// CI). It must prove the secret block holds for the RIGHT REASON, not by
// accident: a naive `cat environ && exit 1` exits non-zero for BOTH a permission
// failure (EACCES — the real userns block, SAFE) and a missing process (ESRCH —
// the sentinel died, proves NOTHING), so on a host that actually leaks a sentinel
// that exited early would false-pass. The checks, in order:
//   1. self /proc/self/{fd,maps} readable — the property that makes bunx work.
//   2. the sentinel is ALIVE — /proc/<pid>/status readable. A dead pid fails
//      here, so a later open-failure cannot be ESRCH.
//   3. environ + maps OPENS fail. `(: < path)` is the no-op builtin with a read
//      redirect: the SHELL opens the file (the same open(2) path Bun/an attacker
//      uses), so a cross-userns EACCES makes the redirect fail and the leak-exit
//      is skipped, while a successful open (a leak) runs `exit PROC_BIND_LEAK`.
//      This replaces an earlier `cat … | grep 'Permission denied'`, which
//      depended on a localized errno STRING (a non-C locale would mistranslate it
//      → grep miss → silent fallback to tmpfs → the bunx crash returns) and on
//      PATH resolving `cat`/`grep` under --clearenv. The redirect uses no external
//      command and no error text, so it is locale- and PATH-independent.
// The exit codes are DISTINCT by outcome so the caller can cache only definitive
// verdicts: setup checks exit PROC_BIND_SETUP_FAILED (inconclusive — a bwrap that
// started but lacks /proc/self/fd, etc.), a detected leak exits PROC_BIND_LEAK
// (definitive unsafe), a clean run exits PROC_BIND_SAFE. A bare `exit 1` would
// conflate setup failures with leaks and poison the cache.
// NOTE: `test -r` is deliberately NOT used for the protected files. It asks
// access(2) (permission bits + uid), which on a same-uid /proc/<pid>/environ
// returns "readable" even when the ptrace-gated open(2) is actually blocked —
// empirically verified. Only an open attempt exercises the real leak path.
// The `2>/dev/null` needs /dev/null, so the probe's bwrap args include `--dev
// /dev` (matching build.ts's proc-bind branch). Without it the redirect fails and
// the verdict is unreliable — the bwrap probe MUST keep `--dev /dev`.
export function buildProcBindProbeScript(sentinelPid: number): string {
  const blockedOpen = (path: string): string => `(: < ${path}) 2>/dev/null && exit ${PROC_BIND_LEAK}`
  return [
    `test -r /proc/self/fd || exit ${PROC_BIND_SETUP_FAILED}`,
    `test -r /proc/self/maps || exit ${PROC_BIND_SETUP_FAILED}`,
    `test -r /proc/${sentinelPid}/status || exit ${PROC_BIND_SETUP_FAILED}`,
    blockedOpen(`/proc/${sentinelPid}/environ`),
    blockedOpen(`/proc/${sentinelPid}/maps`),
    `exit ${PROC_BIND_SAFE}`,
  ].join('; ')
}

async function parentReadsSentinelMarker(sentinelPid: number): Promise<boolean> {
  // Direct read, not a `cat` subprocess: an actual open(2)+read is the real leak
  // path (matching the in-sandbox `(: < path)` check), with no spawn and no PATH
  // dependence in this non-clearenv parent context. We assert the MARKER bytes are
  // present, not merely that the read succeeded: this (a) makes the check robust
  // even if a procfs/Bun edge returned an empty buffer instead of throwing, and
  // (b) confirms the pid still resolves to OUR sentinel — a reused pid would carry
  // a different environ, failing the marker match. `.bytes()` forces the read so a
  // security-gated file that stats fine but blocks read is reported unreadable.
  try {
    const bytes = await Bun.file(`/proc/${sentinelPid}/environ`).bytes()
    return new TextDecoder().decode(bytes).includes(`${PROC_BIND_PROBE_SECRET}=leaked`)
  } catch {
    return false
  }
}

export function _resetProcBindProbeCacheForTests(): void {
  procBindProbeCache.clear()
  procBindProbeInFlight.clear()
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
