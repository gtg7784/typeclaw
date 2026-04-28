import type { Reloadable, ReloadAllResult, ReloadResult } from './types'

export class ReloadRegistry {
  private items = new Map<string, Reloadable>()

  register(item: Reloadable): void {
    if (this.items.has(item.scope)) {
      throw new Error(`reload scope "${item.scope}" is already registered`)
    }
    this.items.set(item.scope, item)
  }

  has(scope: string): boolean {
    return this.items.has(scope)
  }

  get(scope: string): Reloadable | undefined {
    return this.items.get(scope)
  }

  list(): Reloadable[] {
    return Array.from(this.items.values())
  }

  // Runs serially in registration order. Reloadables observe the side
  // effects of earlier ones — e.g. cron reload reads the freshly swapped
  // config when it runs after the config reloadable. Manual reload is rare,
  // so deterministic ordering wins over parallelism.
  async reloadAll(): Promise<ReloadAllResult> {
    const results: ReloadResult[] = []
    for (const item of this.list()) {
      try {
        results.push(await item.reload())
      } catch (err) {
        results.push({ scope: item.scope, ok: false, reason: errorMessage(err) })
      }
    }
    return { results }
  }

  async reloadOne(scope: string): Promise<ReloadResult> {
    const item = this.items.get(scope)
    if (!item) return { scope, ok: false, reason: `unknown scope: ${scope}` }
    try {
      return await item.reload()
    } catch (err) {
      return { scope, ok: false, reason: errorMessage(err) }
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
