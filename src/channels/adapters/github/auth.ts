import type { GithubAppAuthBlock, GithubPatAuthBlock } from '@/secrets/schema'

import { AppAuthStrategy } from './auth-app'
import { PatAuthStrategy } from './auth-pat'

export type GithubAuthStrategy = {
  token: () => Promise<string>
  authHeaders: () => Promise<HeadersInit>
  getSelf: () => Promise<GithubSelfUser>
  // App-only: returns the installation's granted-permissions map and declared
  // events so the adapter can preflight against the configured eventAllowlist
  // before any webhook arrives. PATs return access via token scopes, not an
  // installation grant, so they leave this undefined.
  getInstallationGrants?: () => Promise<GithubInstallationGrants>
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
        installationId: options.auth.installationId,
        fetchImpl: options.fetchImpl,
      })
  }
}
