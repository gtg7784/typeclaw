export type WaitForOptions = {
  timeoutMs?: number
  intervalMs?: number
  description?: string
}

// 5s, not 1s. 1s was tight enough to be the dominant cause of `bun test --parallel`
// flakes on macOS: under 18-worker concurrent shell-spawn load, the kernel can
// take >1s to drain a child process's stderr pipe past the libuv → JS boundary,
// so a `waitFor` for "fake-cloudflared printed a URL" loses the race. 5s costs
// nothing on the happy path (the polled predicate returns truthy as soon as it
// can; this is just the timeout, not the wait), and absorbs realistic load.
const DEFAULT_TIMEOUT_MS = 5_000
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
