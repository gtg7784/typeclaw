import type { GithubAppAuthBlock, GithubPatAuthBlock } from '@/secrets/schema'

import { AppAuthStrategy } from './auth-app'
import { PatAuthStrategy } from './auth-pat'

export type GithubAuthStrategy = {
  token: () => Promise<string>
  authHeaders: () => Promise<HeadersInit>
  getSelf: () => Promise<GithubSelfUser>
  dispose: () => Promise<void>
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
