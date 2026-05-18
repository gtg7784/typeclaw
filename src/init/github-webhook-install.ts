import { buildAuthStrategy } from '@/channels/adapters/github/auth'
import { registerGithubWebhooks, type WebhookRegistrationResult } from '@/channels/adapters/github/webhook-register'
import { DEFAULT_GITHUB_EVENT_ALLOWLIST } from '@/channels/schema'

import type { GithubInitCredentials } from './index'

// Host-side webhook install for `typeclaw channel add github` (and the
// init-time GitHub branch). The container-side adapter still re-runs this on
// every start so a missing/rotated tunnel URL eventually catches up, but
// doing it eagerly here means the user sees the install succeed at CLI
// time — no more "I added the channel, why isn't GitHub delivering events?"
// when the URL is already known (external provider, or a user-set
// webhookUrl).
//
// Only fires when an effective webhook URL is known up front: external
// tunnel provider, or an explicit `webhookUrl`. Cloudflare quick tunnels
// don't resolve until cloudflared boots inside the container, so they
// stay on the existing deferred (tunnel-bridge → restartAdapter) path.

export type EagerGithubWebhookInstallOptions = {
  webhookUrl: string
  webhookSecret: string
  repos: readonly string[]
  events?: readonly string[]
  auth: GithubInitCredentials['auth']
  fetchImpl?: typeof fetch
}

export type EagerGithubWebhookInstallResult = WebhookRegistrationResult | { error: string; repos: [] }

export async function installGithubWebhooksEagerly(
  options: EagerGithubWebhookInstallOptions,
): Promise<EagerGithubWebhookInstallResult> {
  if (options.repos.length === 0) return { repos: [] }

  let strategy: ReturnType<typeof buildAuthStrategy>
  try {
    strategy = buildAuthStrategy({
      auth: authToSecretBlock(options.auth),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    })
  } catch (err) {
    return { error: describe(err), repos: [] }
  }

  try {
    const result = await registerGithubWebhooks({
      token: () => strategy.token(),
      webhookUrl: options.webhookUrl,
      webhookSecret: options.webhookSecret,
      repos: options.repos,
      events: options.events ?? DEFAULT_GITHUB_EVENT_ALLOWLIST,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    })
    return result
  } finally {
    // PatAuthStrategy.dispose() is a no-op and AppAuthStrategy clears its
    // cached installation token. Either way, releasing it here keeps the
    // host CLI from holding onto credentials longer than needed.
    await strategy.dispose().catch(() => {})
  }
}

// Bridge the wizard/CLI's plaintext credentials union into the Secret-wrapped
// shape buildAuthStrategy expects. Plain strings are wrapped as `{ value }`
// so the underlying PatAuthStrategy resolver doesn't try (and fail) to read
// from process.env.
function authToSecretBlock(auth: GithubInitCredentials['auth']) {
  if (auth.type === 'pat') {
    return { type: 'pat' as const, token: { value: auth.pat } }
  }
  return {
    type: 'app' as const,
    appId: auth.appId,
    privateKey: { value: auth.privateKey },
    ...(auth.installationId !== undefined ? { installationId: auth.installationId } : {}),
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function formatEagerGithubWebhookInstallResult(result: EagerGithubWebhookInstallResult): string {
  if ('error' in result) return `GitHub webhook install failed: ${result.error}`
  const created = result.repos.filter((r) => r.action === 'created').length
  const updated = result.repos.filter((r) => r.action === 'updated').length
  const failed = result.repos.filter((r) => r.action === 'failed')
  const parts: string[] = []
  if (created > 0) parts.push(`${created} created`)
  if (updated > 0) parts.push(`${updated} updated`)
  if (failed.length > 0) parts.push(`${failed.length} failed`)
  const summary = parts.length > 0 ? parts.join(', ') : 'no repos'
  const tail = failed.length > 0 ? ` (${failed.map((f) => `${f.repo}: ${f.error}`).join('; ')})` : ''
  return `GitHub webhooks: ${summary}.${tail}`
}
