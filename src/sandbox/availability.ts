import { SandboxUnavailableError } from './errors'

// Cached because the binary cannot appear or disappear during a single
// process lifetime, and a probe per bash call is wasted work. Keyed by the
// resolved bwrap path so a test (or a consumer pinning a non-default path)
// re-probes instead of reading another path's cached result.
const availabilityCache = new Map<string, boolean>()

export async function ensureBwrapAvailable(options?: { bwrapPath?: string }): Promise<void> {
  const bwrap = options?.bwrapPath ?? 'bwrap'
  const cached = availabilityCache.get(bwrap)
  if (cached === true) return
  if (cached === false) throw new SandboxUnavailableError()

  const available = await probe(bwrap)
  availabilityCache.set(bwrap, available)
  if (!available) throw new SandboxUnavailableError()
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
