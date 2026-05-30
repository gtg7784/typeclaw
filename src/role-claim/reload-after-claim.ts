import { requestReload, type ReloadResult } from '@/reload'

export interface ReloadAfterClaimOptions {
  url: string
  reload?: (opts: { url: string; scope: string }) => Promise<ReloadResult[]>
}

export type ReloadAfterClaimResult = { ok: true; results: ReloadResult[] } | { ok: false; reason: string }

// Best-effort by contract: the role is already persisted to typeclaw.json by
// the time a claim completes, so a reload failure here must NOT fail the claim.
// Callers surface the reason but keep the claim successful.
export async function reloadAfterClaim(opts: ReloadAfterClaimOptions): Promise<ReloadAfterClaimResult> {
  const reload = opts.reload ?? requestReload
  try {
    const results = await reload({ url: opts.url, scope: 'config' })
    return { ok: true, results }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
