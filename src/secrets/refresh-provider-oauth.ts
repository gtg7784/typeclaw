import { join } from 'node:path'

import type { AuthStorage } from '@mariozechner/pi-coding-agent'

import { createSecretsStoreForAgent } from './storage'

// Outcome for a single provider's proactive-refresh probe. `valid-or-refreshed`
// collapses "token was still good" and "token was expired and we refreshed it"
// on purpose — from the caller's view both mean "this provider can serve a turn
// now", and the SDK doesn't tell us which of the two happened. `refresh-failed`
// is the only actionable state: the token was expired and the refresh POST (or
// the lookup of the OAuth provider) did not yield a usable key.
export type ProviderRefreshOutcome = 'valid-or-refreshed' | 'refresh-failed'

export type ProviderRefreshEntry = {
  providerId: string
  outcome: ProviderRefreshOutcome
  // Populated only for `refresh-failed`, drained from AuthStorage's internal
  // error log so operators see WHY the refresh failed (network, 400 from the
  // token endpoint, revoked refresh token, unknown OAuth provider).
  error?: string
}

export type RefreshProviderOAuthResult = {
  entries: ProviderRefreshEntry[]
}

export type RefreshProviderOAuthOptions = {
  authStorage: AuthStorage
  log?: (message: string) => void
}

// Proactively resolves every stored OAuth provider credential once, forcing the
// SDK's lazy refresh-and-persist path to run at boot instead of on the first
// user-facing turn.
//
// WHY THIS EXISTS. `AuthStorage.getApiKey()` is the SDK's only refresh trigger,
// and it is lazy: it fires on the first LLM call for a provider. A container
// that restarts with an already-expired access token therefore doesn't refresh
// until a real turn runs — and if that refresh then fails (a wedged network
// stack, a rotated refresh token), the failure surfaces as a generic
// provider-error notice posted into a live channel/PR thread. Channel-adapter
// OAuth already has host-side renewal crons (Kakao/Webex/Teams); provider OAuth
// had nothing. This closes that gap by paying the refresh cost at boot, where a
// failure is logged for the operator rather than shown to end users.
//
// Reuses the SDK path verbatim rather than re-implementing token refresh: a
// single `getApiKey()` call per provider runs the exact locked
// refresh-then-persist-to-secrets.json flow the runtime uses on every turn, so
// a boot-refreshed token is written back through the same atomic writer and no
// second refresh implementation can drift from it. `includeFallback: false`
// keeps an unrelated env var from masking an OAuth refresh failure as success.
//
// Never throws: a boot-time credential probe must not block the agent from
// starting. Each provider is isolated — one provider's failure doesn't stop the
// others from being probed — and every failure is returned for the caller to
// log.
export async function refreshProviderOAuthCredentials(
  options: RefreshProviderOAuthOptions,
): Promise<RefreshProviderOAuthResult> {
  const { authStorage } = options
  const entries: ProviderRefreshEntry[] = []

  const oauthProviderIds = Object.entries(authStorage.getAll())
    .filter(([, cred]) => cred.type === 'oauth')
    .map(([providerId]) => providerId)

  for (const providerId of oauthProviderIds) {
    // getApiKey drives the locked refresh-and-persist internally. A non-empty
    // return means the provider can serve a turn now (token was valid, or was
    // expired and got refreshed + written back). `undefined` means the refresh
    // truly failed — the SDK deliberately does NOT fall back to the stale token.
    const apiKey = await resolveApiKeySafely(authStorage, providerId)
    // Always drain so one provider's recorded error can't leak into the next
    // provider's outcome. drainErrors clears the buffer as it reads.
    const drained = authStorage.drainErrors()

    if (apiKey !== undefined && apiKey !== '') {
      entries.push({ providerId, outcome: 'valid-or-refreshed' })
      continue
    }

    const error = drained.length > 0 ? drained.map((e) => e.message).join('; ') : 'refresh returned no API key'
    options.log?.(`refreshProviderOAuth: ${providerId} refresh failed: ${error}`)
    entries.push({ providerId, outcome: 'refresh-failed', error })
  }

  return { entries }
}

// getApiKey already swallows refresh errors into drainErrors and returns
// undefined, but guard the call itself so an unexpected throw (e.g. a corrupt
// credential shape the SDK doesn't expect) degrades to a failed entry instead
// of aborting the whole boot-time sweep.
async function resolveApiKeySafely(authStorage: AuthStorage, providerId: string): Promise<string | undefined> {
  try {
    return await authStorage.getApiKey(providerId, { includeFallback: false })
  } catch {
    return undefined
  }
}

export type RefreshProviderOAuthForAgentOptions = {
  agentDir: string
  log?: (message: string) => void
}

// Boot-time convenience wrapper for src/run/index.ts, mirroring
// exportCodexAuthFileForAgent's contract: takes agentDir, never throws, returns
// a result the caller can log or ignore. Builds the same AuthStorage the run
// stage uses per provider (createSecretsStoreForAgent) so the refresh writes
// back through the bind-mounted secrets.json exactly as a live turn would.
export async function refreshProviderOAuthForAgent(
  options: RefreshProviderOAuthForAgentOptions,
): Promise<RefreshProviderOAuthResult> {
  let authStorage: AuthStorage
  try {
    authStorage = createSecretsStoreForAgent(join(options.agentDir, 'secrets.json'))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    options.log?.(`refreshProviderOAuth: ${reason}`)
    return { entries: [] }
  }
  return refreshProviderOAuthCredentials({
    authStorage,
    ...(options.log !== undefined ? { log: options.log } : {}),
  })
}
