export type WaitForOptions = {
  timeoutMs?: number
  intervalMs?: number
  description?: string
}

const DEFAULT_TIMEOUT_MS = 1_000
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
