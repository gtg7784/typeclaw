import type { GithubAppAuthBlock, GithubPatAuthBlock } from '@/secrets/schema'

import { AppAuthStrategy } from './auth-app'
import { PatAuthStrategy } from './auth-pat'

// Repo identity threaded through every auth call so App auth can pick the
// correct installation. `repoSlug` is the canonical input ("owner/name"); App
// auth resolves it to an installation via GET /repos/{owner}/{repo}/installation
// and caches the result. PAT auth ignores it entirely. Omitted context means
// "no specific repo" — App auth then falls back to a single discoverable
// installation (and errors if the App spans multiple installations).
export type GithubAuthContext = {
  repoSlug?: string
  // Org login, for operations that aren't repo-scoped (e.g. team-membership
  // lookups under GET /orgs/{org}/...). App auth resolves it to an
  // installation via GET /orgs/{org}/installation. Ignored when repoSlug is set.
  owner?: string
}

export type GithubAuthStrategy = {
  token: (context?: GithubAuthContext) => Promise<string>
  authHeaders: (context?: GithubAuthContext) => Promise<HeadersInit>
  getSelf: () => Promise<GithubSelfUser>
  // App-only: returns the installation's granted-permissions map and declared
  // events so the adapter can preflight against the configured eventAllowlist
  // before any webhook arrives. PATs return access via token scopes, not an
  // installation grant, so they leave this undefined. Context selects which
  // installation to inspect when the App spans multiple owners.
  getInstallationGrants?: (context?: GithubAuthContext) => Promise<GithubInstallationGrants>
  dispose: () => Promise<void>
}

export type GithubInstallationGrants = {
  permissions: Readonly<Record<string, 'read' | 'write' | 'admin'>>
  events: readonly string[]
}

export type GithubSelfUser = {
  login: string
  id: number
}

export function buildAuthStrategy(options: {
  auth: GithubPatAuthBlock | GithubAppAuthBlock
  fetchImpl?: typeof fetch
}): GithubAuthStrategy {
  switch (options.auth.type) {
    case 'pat':
      return new PatAuthStrategy({ token: options.auth.token, fetchImpl: options.fetchImpl })
    case 'app':
      return new AppAuthStrategy({
        appId: options.auth.appId,
        privateKey: options.auth.privateKey,
        fetchImpl: options.fetchImpl,
      })
  }
}
