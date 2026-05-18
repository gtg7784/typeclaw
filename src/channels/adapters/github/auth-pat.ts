import { resolveSecret, type Secret } from '@/secrets/resolve'

import type { GithubAuthStrategy, GithubSelfUser } from './auth'

export const GITHUB_API_BASE = 'https://api.github.com'

export class PatAuthStrategy implements GithubAuthStrategy {
  readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(options: { token: Secret; fetchImpl?: typeof fetch }) {
    const token = resolveSecret(options.token, undefined, process.env)
    if (token === undefined || token.trim() === '') throw new Error('GitHub PAT token is missing')
    this.token = token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  authHeaders(): HeadersInit {
    return githubJsonHeaders(this.token)
  }

  async getSelf(): Promise<GithubSelfUser> {
    const response = await this.fetchImpl(`${GITHUB_API_BASE}/user`, { headers: this.authHeaders() })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`GitHub PAT authentication failed: ${response.status}${body !== '' ? ` ${body}` : ''}`)
    }
    const raw = (await response.json()) as { login?: unknown; id?: unknown }
    if (typeof raw.login !== 'string' || typeof raw.id !== 'number') {
      throw new Error('GitHub /user response did not include login/id')
    }
    return { login: raw.login, id: raw.id }
  }
}

export function githubJsonHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'typeclaw-github-channel',
  }
}
