import type { GithubPatAuthBlock } from '@/secrets/schema'

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

export function buildAuthStrategy(options: { auth: GithubPatAuthBlock; fetchImpl?: typeof fetch }): GithubAuthStrategy {
  return new PatAuthStrategy({ token: options.auth.token, fetchImpl: options.fetchImpl })
}
