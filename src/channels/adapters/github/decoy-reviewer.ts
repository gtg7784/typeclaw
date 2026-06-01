import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'

// `absent` separates "GitHub says the reviewer is already not requested"
// (404/422 — never on the list, already removed, or invalid for the repo) from
// `failed` ("couldn't reach GitHub"), so callers warn only on the latter.
export type RemoveRequestedReviewerResult =
  | { kind: 'removed'; status: number }
  | { kind: 'absent'; status: number; message: string }
  | { kind: 'failed'; status?: number; reason: string }

export async function removeRequestedReviewer(params: {
  fetchImpl: typeof fetch
  token: string
  owner: string
  repo: string
  pullNumber: number
  reviewerLogin: string
}): Promise<RemoveRequestedReviewerResult> {
  const url = `${GITHUB_API_BASE}/repos/${params.owner}/${params.repo}/pulls/${params.pullNumber}/requested_reviewers`
  try {
    const response = await params.fetchImpl(url, {
      method: 'DELETE',
      headers: githubJsonHeaders(params.token),
      body: JSON.stringify({ reviewers: [params.reviewerLogin] }),
    })
    if (response.ok) return { kind: 'removed', status: response.status }
    const message = await response.text().catch(() => '')
    // 404 (PR/reviewer not found) and 422 (reviewer not currently requested,
    // or not a valid reviewer for this repo) mean there is nothing to remove —
    // the desired end state already holds. Everything else (401/403 auth,
    // 429 rate, 5xx) is a real failure worth surfacing.
    if (response.status === 404 || response.status === 422) {
      return { kind: 'absent', status: response.status, message }
    }
    return {
      kind: 'failed',
      status: response.status,
      reason: `GitHub API ${response.status}${message !== '' ? `: ${message}` : ''}`,
    }
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}
