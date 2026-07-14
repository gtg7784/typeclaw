export const DEFAULT_DISCORD_RESOLVER_CACHE_ENTRIES = 1_000

type CacheEntry<T> = { value: T; expiresAt: number }

export class DiscordResolverCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>()
  readonly #maxEntries: number

  constructor(maxEntries = DEFAULT_DISCORD_RESOLVER_CACHE_ENTRIES) {
    this.#maxEntries = Math.max(1, maxEntries)
  }

  get(key: string, now: number): T | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now) {
      this.#entries.delete(key)
      return undefined
    }
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, expiresAt: number, now: number): void {
    for (const [candidate, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(candidate)
    }
    this.#entries.delete(key)
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    this.#entries.set(key, { value, expiresAt })
  }

  delete(key: string): void {
    this.#entries.delete(key)
  }
}
