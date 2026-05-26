export type WaitForOptions = {
  timeoutMs?: number
  intervalMs?: number
  description?: string
}

// 30s, not 5s. 5s was tight enough to flake on heavy-load callers (the WS
// pipeline assembly in src/portbroker/broker.test.ts is the canonical case:
// host-side `Bun.listen` accept → broker connect → port discovery → snapshot
// fanout → data round-trip is a 5-hop chain across two event loops, and the
// 5s deadline was reached when libuv contention queued one of those hops).
// The original 1s → 5s bump (commit b6a3ef9-era) acknowledged the same
// failure mode for fake-cloudflared stderr drain; the WS pipeline pushed
// the bound one tier higher. 30s costs nothing on the happy path (the
// polled predicate returns truthy as soon as it can; this is just the
// timeout, not the wait), absorbs realistic 18-worker contention, and
// matches the global `setDefaultTimeout(30_000)` in
// scripts/require-parallel.ts so a wedged waitFor surfaces as a clear
// "waitFor: ... did not become truthy within 30000ms" message before the
// outer test-level timeout fires with no context.
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_INTERVAL_MS = 1

export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options: WaitForOptions = {},
): Promise<NonNullable<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  const initial = await predicate()
  if (initial) return initial as NonNullable<T>

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
    const result = await predicate()
    if (result) return result as NonNullable<T>
  }

  const label = options.description ?? 'condition'
  throw new Error(`waitFor: ${label} did not become truthy within ${timeoutMs}ms`)
}

// Asserts that `predicate` STAYS falsy for the full `durationMs`. Unlike
// `waitFor`, this MUST pay the full duration — you cannot observe the absence
// of an event faster than waiting for it. Use sparingly, and keep durations
// tight.
export async function expectStable<T>(
  predicate: () => T | Promise<T>,
  options: { durationMs: number; intervalMs?: number; description?: string },
): Promise<void> {
  const intervalMs = options.intervalMs ?? 5
  const deadline = Date.now() + options.durationMs

  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) {
      const label = options.description ?? 'condition'
      throw new Error(`expectStable: ${label} became truthy before ${options.durationMs}ms elapsed`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}
