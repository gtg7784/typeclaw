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
  let results: ReloadResult[]
  try {
    results = await reload({ url: opts.url, scope: 'config' })
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }

  // requestReload resolves even when the server reports a per-scope failure, so
  // an exception-free call is not proof the config actually reloaded. Surface
  // any failed scope (and an empty result, which means nothing reloaded) as a
  // failure so the caller can tell the user to reload manually.
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    return { ok: false, reason: failed.map((r) => `${r.scope}: ${r.reason}`).join('; ') }
  }
  if (results.length === 0) {
    return { ok: false, reason: 'no reloadable config scope responded' }
  }
  return { ok: true, results }
}
