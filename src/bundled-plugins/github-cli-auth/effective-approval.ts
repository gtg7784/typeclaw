import { GITHUB_API_BASE, githubJsonHeaders } from '@/channels/adapters/github/auth-pat'

import type { EffectiveApprovalResolver } from './approve-idempotency'

// Resolves whether THIS bot already has a standing APPROVED review on a PR, used
// by the approve-idempotency guard to stop a second formal APPROVE after a
// restart (the in-process pending set covers the same-container case but is lost
// when the container bounces). Every failure returns { ok: false } so the guard
// fails open — a transient read error must never permanently block a genuine
// first approval.
export function createGithubEffectiveApprovalResolver(deps: {
  resolveToken: (workspace: string) => Promise<string | null>
  fetchImpl?: typeof fetch
}): EffectiveApprovalResolver {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async ({ workspace, prNumber }) => {
    const [owner, repo] = workspace.split('/')
    if (owner === undefined || owner === '' || repo === undefined || repo === '') return { ok: false }

    const token = await deps.resolveToken(workspace).catch(() => null)
    if (token === null || token === '') return { ok: false }

    const self = await fetchSelfLogin(fetchImpl, token)
    if (self === null) return { ok: false }

    const reviews = await fetchReviews(fetchImpl, token, owner, repo, prNumber)
    if (reviews === null) return { ok: false }

    const alreadyApproved = reviews.some((r) => r.state === 'APPROVED' && isSelf(r.login, r.isBot, self))
    return { ok: true, alreadyApproved }
  }
}

type ReviewRow = { state: string; login: string; isBot: boolean }

async function fetchSelfLogin(fetchImpl: typeof fetch, token: string): Promise<string | null> {
  try {
    const response = await fetchImpl(`${GITHUB_API_BASE}/user`, { headers: githubJsonHeaders(token) })
    if (!response.ok) return null
    const raw = (await response.json().catch(() => null)) as { login?: unknown } | null
    return typeof raw?.login === 'string' ? raw.login : null
  } catch {
    return null
  }
}

async function fetchReviews(
  fetchImpl: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewRow[] | null> {
  try {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`
    const response = await fetchImpl(url, { headers: githubJsonHeaders(token) })
    if (!response.ok) return null
    const page = (await response.json().catch(() => null)) as RawReview[] | null
    if (page === null) return null
    const rows: ReviewRow[] = []
    for (const row of page) {
      if (typeof row.state !== 'string') continue
      const login = row.user?.login
      if (typeof login !== 'string') continue
      rows.push({ state: row.state, login, isBot: row.user?.type === 'Bot' })
    }
    return rows
  } catch {
    return null
  }
}

const BOT_LOGIN_SUFFIX = '[bot]'

// A GitHub App's reviews login is `slug[bot]` while `/user` returns the bare
// slug, so normalize before comparing — but only for actual Bot reviewers, since
// a human could legitimately own a login matching the bare slug.
function isSelf(login: string, isBot: boolean, selfLogin: string): boolean {
  if (isBot) return normalizeBotLogin(login) === normalizeBotLogin(selfLogin)
  return login === selfLogin
}

function normalizeBotLogin(login: string): string {
  return login.endsWith(BOT_LOGIN_SUFFIX) ? login.slice(0, -BOT_LOGIN_SUFFIX.length) : login
}

type RawReview = { state?: unknown; user?: { login?: string; type?: string } }
