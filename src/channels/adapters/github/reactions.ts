import type { ReactionCallback, ReactionErrorCode, ReactionRef, ReactionResult } from '@/channels/types'

import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import {
  buildOutboundPermissionGuidance,
  type GithubAuthType,
  isOutboundPermissionDenial,
  type OutboundEndpointKind,
} from './permission-guidance'

// The reactable target, distinguished by the webhook event the inbound came
// from. The router collapses every github inbound to the same `chat`/
// `externalMessageId` pair, so this kind — known only at classification time —
// is what selects the right Reactions endpoint. `issue` covers both issue and
// PR bodies (GitHub models a PR body as an issue for reactions); `discussion`
// is unsupported until the GraphQL `addReaction` path lands, so the classifier
// does not stamp it today.
export type GithubReactionTarget =
  | { kind: 'issue'; owner: string; repo: string; issueNumber: number }
  | { kind: 'issue-comment'; owner: string; repo: string; commentId: number }
  | { kind: 'pr-review-comment'; owner: string; repo: string; commentId: number }

export function encodeGithubReactionRef(target: GithubReactionTarget): ReactionRef {
  return { adapter: 'github', value: JSON.stringify(target) }
}

export function decodeGithubReactionRef(ref: ReactionRef): GithubReactionTarget | null {
  if (ref.adapter !== 'github') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(ref.value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const t = parsed as Record<string, unknown>
  const owner = typeof t.owner === 'string' ? t.owner : null
  const repo = typeof t.repo === 'string' ? t.repo : null
  if (owner === null || repo === null) return null
  if (t.kind === 'issue' && typeof t.issueNumber === 'number') {
    return { kind: 'issue', owner, repo, issueNumber: t.issueNumber }
  }
  if ((t.kind === 'issue-comment' || t.kind === 'pr-review-comment') && typeof t.commentId === 'number') {
    return { kind: t.kind, owner, repo, commentId: t.commentId }
  }
  return null
}

// GitHub's Reactions API takes a fixed vocabulary of content strings. Map the
// adapter-generic emoji name onto it; anything outside the set is reported as
// `unsupported` so the model gets a clear signal rather than a silent 422.
const REACTION_CONTENT: Record<string, string> = {
  eyes: 'eyes',
  '+1': '+1',
  thumbsup: '+1',
  '-1': '-1',
  thumbsdown: '-1',
  laugh: 'laugh',
  hooray: 'hooray',
  tada: 'hooray',
  confused: 'confused',
  heart: 'heart',
  rocket: 'rocket',
}

export function createGithubReactionCallback(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  authType: GithubAuthType
  fetchImpl?: typeof fetch
}): ReactionCallback {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'github') return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    const content = REACTION_CONTENT[req.emoji.replace(/^:|:$/g, '')]
    if (content === undefined) {
      return { ok: false, error: `github does not support reaction "${req.emoji}"`, code: 'unsupported' }
    }
    const target = decodeGithubReactionRef(req.reactionRef)
    if (target === null) return { ok: false, error: 'unparseable github reaction ref', code: 'unsupported' }

    const endpoint = reactionEndpoint(target)
    const endpointKind: OutboundEndpointKind =
      target.kind === 'pr-review-comment' ? 'pr-review-comment-reaction' : 'issue-reaction'
    return await postReaction(fetchImpl, await deps.token({ repoSlug: `${target.owner}/${target.repo}` }), endpoint, {
      content,
      authType: deps.authType,
      endpointKind,
    })
  }
}

function reactionEndpoint(target: GithubReactionTarget): string {
  const base = `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}`
  switch (target.kind) {
    case 'issue':
      return `${base}/issues/${target.issueNumber}/reactions`
    case 'issue-comment':
      return `${base}/issues/comments/${target.commentId}/reactions`
    case 'pr-review-comment':
      return `${base}/pulls/comments/${target.commentId}/reactions`
  }
}

async function postReaction(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  options: { content: string; authType: GithubAuthType; endpointKind: OutboundEndpointKind },
): Promise<ReactionResult> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: githubJsonHeaders(token),
      body: JSON.stringify({ content: options.content }),
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'transient' }
  }
  // 201 = reaction created, 200 = the actor already left this same reaction.
  // Both are success: an :eyes: that's already there is the desired end state,
  // so a duplicate webhook delivery (or a retried engage) must not surface an error.
  if (response.status === 200 || response.status === 201) return { ok: true }
  const text = await response.text().catch(() => '')
  const baseError = `GitHub API ${response.status}${text !== '' ? `: ${text}` : ''}`
  if (isOutboundPermissionDenial(response.status, text)) {
    return {
      ok: false,
      error: `${baseError}${buildOutboundPermissionGuidance({ authType: options.authType, endpointKind: options.endpointKind })}`,
      code: 'permission-denied',
    }
  }
  return { ok: false, error: baseError, code: classifyStatus(response.status) }
}

function classifyStatus(status: number): ReactionErrorCode {
  if (status === 403) return 'permission-denied'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limited'
  return 'transient'
}
