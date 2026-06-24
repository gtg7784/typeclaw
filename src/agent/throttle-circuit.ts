import { providerForModelRef, type ModelRef } from '@/config/providers'

export const THROTTLE_THRESHOLD = 2
export const THROTTLE_WINDOW_MS = 60_000
export const COOLDOWN_MS = 180_000

export type ThrottleCircuitKey = {
  profile?: string
  ref: ModelRef
}

type CircuitEntry = {
  failures: number[]
  openUntil: number
}

export class ThrottleCircuit {
  private readonly entries = new Map<string, CircuitEntry>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  isOpen(key: ThrottleCircuitKey): boolean {
    const entry = this.entries.get(this.keyId(key))
    if (entry === undefined) return false
    return this.now() < entry.openUntil
  }

  recordThrottle(key: ThrottleCircuitKey): void {
    const id = this.keyId(key)
    const now = this.now()
    const entry = this.entries.get(id) ?? { failures: [], openUntil: 0 }
    entry.failures = entry.failures.filter((ts) => now - ts <= THROTTLE_WINDOW_MS)
    entry.failures.push(now)
    if (entry.failures.length >= THROTTLE_THRESHOLD) entry.openUntil = now + COOLDOWN_MS
    this.entries.set(id, entry)
  }

  recordSuccess(key: ThrottleCircuitKey): void {
    this.entries.delete(this.keyId(key))
  }

  private keyId(key: ThrottleCircuitKey): string {
    return `${key.profile ?? 'default'}:${providerForModelRef(key.ref)}:${key.ref}`
  }
}

export const modelThrottleCircuit = new ThrottleCircuit()
