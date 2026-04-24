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

  async reloadAll(): Promise<ReloadAllResult> {
    const items = this.list()
    const settled = await Promise.allSettled(items.map((item) => item.reload()))
    const results: ReloadResult[] = settled.map((s, i) => {
      const scope = items[i]!.scope
      if (s.status === 'fulfilled') return s.value
      return { scope, ok: false, reason: errorMessage(s.reason) }
    })
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
