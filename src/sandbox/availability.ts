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
