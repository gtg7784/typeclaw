import type { OutboundCallback, OutboundMessage, SendResult } from '@/channels/types'

import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import {
  buildOutboundPermissionGuidance,
  type GithubAuthType,
  isOutboundPermissionDenial,
  type OutboundEndpointKind,
} from './permission-guidance'

export type GithubOutboundLogger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

export function createGithubOutboundCallback(deps: {
  token: () => Promise<string>
  authType: GithubAuthType
  logger: GithubOutboundLogger
  fetchImpl?: typeof fetch
}): OutboundCallback {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'github') return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    if ((msg.attachments ?? []).length > 0) return { ok: false, error: 'github-bot-does-not-support-attachments' }
    const body = msg.text ?? ''
    if (body === '') return { ok: false, error: 'message has neither text nor attachments' }

    const repo = parseRepo(msg.workspace)
    if (repo === null) return { ok: false, error: `invalid GitHub workspace: ${msg.workspace}` }
    const target = parseChat(msg.chat)
    if (target === null) return { ok: false, error: `invalid GitHub chat: ${msg.chat}` }

    if (target.kind === 'discussion') {
      return await postDiscussionComment({
        ...deps,
        fetchImpl,
        repo,
        discussionNumber: target.number,
        body,
      })
    }

    const isPrReviewReply = target.kind === 'pr' && msg.thread !== null && msg.thread !== undefined && msg.thread !== ''
    const endpoint = isPrReviewReply
      ? `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${target.number}/comments/${encodeURIComponent(msg.thread ?? '')}/replies`
      : `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/issues/${target.number}/comments`
    return await postJson(
      fetchImpl,
      await deps.token(),
      endpoint,
      { body },
      {
        authType: deps.authType,
        endpointKind: isPrReviewReply ? 'pr-review-reply' : 'issue-comment',
      },
    )
  }
}

async function postDiscussionComment(options: {
  token: () => Promise<string>
  authType: GithubAuthType
  fetchImpl: typeof fetch
  repo: RepoRef
  discussionNumber: number
  body: string
}): Promise<SendResult> {
  const discussionId = await fetchDiscussionId(options)
  if (!discussionId.ok) return discussionId
  const mutation = `mutation($discussionId:ID!,$body:String!){addDiscussionComment(input:{discussionId:$discussionId,body:$body}){comment{id}}}`
  return await postGraphql(
    options.fetchImpl,
    await options.token(),
    mutation,
    {
      discussionId: discussionId.id,
      body: options.body,
    },
    { authType: options.authType, endpointKind: 'discussion-comment' },
  )
}

async function fetchDiscussionId(options: {
  token: () => Promise<string>
  authType: GithubAuthType
  fetchImpl: typeof fetch
  repo: RepoRef
  discussionNumber: number
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){discussion(number:$number){id}}}`
  const result = await graphql<{ repository?: { discussion?: { id?: string } | null } }>(
    options.fetchImpl,
    await options.token(),
    query,
    {
      owner: options.repo.owner,
      name: options.repo.name,
      number: options.discussionNumber,
    },
    { authType: options.authType, endpointKind: 'discussion-comment' },
  )
  if (!result.ok) return result
  const id = result.data.repository?.discussion?.id
  return typeof id === 'string' && id !== '' ? { ok: true, id } : { ok: false, error: 'discussion not found' }
}

async function postGraphql(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  guidance: { authType: GithubAuthType; endpointKind: OutboundEndpointKind },
): Promise<SendResult> {
  const result = await graphql(fetchImpl, token, query, variables, guidance)
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

async function graphql<T>(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  guidance: { authType: GithubAuthType; endpointKind: OutboundEndpointKind },
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(`${GITHUB_API_BASE}/graphql`, {
      method: 'POST',
      headers: githubJsonHeaders(token),
      body: JSON.stringify({ query, variables }),
    })
    const raw = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> }
    if (!response.ok || raw.errors !== undefined) {
      // GraphQL errors carry a permission-denial in their `errors[].type` =
      // 'FORBIDDEN' or message text. Match on either the HTTP 403 (rare for
      // GraphQL) or the literal denial string in any error message.
      const message = raw.errors?.map((e) => e.message ?? 'unknown').join('; ') ?? `HTTP ${response.status}`
      const baseError = response.ok ? message : `GitHub API ${response.status}: ${message}`
      const decorated = isOutboundPermissionDenial(response.ok ? 403 : response.status, message)
        ? `${baseError}${buildOutboundPermissionGuidance(guidance)}`
        : baseError
      return { ok: false, error: decorated }
    }
    if (raw.data === undefined) return { ok: false, error: 'GraphQL response missing data' }
    return { ok: true, data: raw.data }
  } catch (err) {
    return { ok: false, error: describe(err) }
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  payload: unknown,
  guidance: { authType: GithubAuthType; endpointKind: OutboundEndpointKind },
): Promise<SendResult> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: githubJsonHeaders(token),
      body: JSON.stringify(payload),
    })
    if (response.ok) return { ok: true }
    const text = await response.text().catch(() => '')
    const baseError = `GitHub API ${response.status}${text !== '' ? `: ${text}` : ''}`
    const decorated = isOutboundPermissionDenial(response.status, text)
      ? `${baseError}${buildOutboundPermissionGuidance(guidance)}`
      : baseError
    return { ok: false, error: decorated }
  } catch (err) {
    return { ok: false, error: describe(err) }
  }
}

type RepoRef = { owner: string; name: string }
type ChatRef = { kind: 'issue' | 'pr' | 'discussion'; number: number }

export function parseRepo(workspace: string): RepoRef | null {
  const [owner, name, extra] = workspace.split('/')
  if (!owner || !name || extra !== undefined) return null
  return { owner, name }
}

export function parseChat(chat: string): ChatRef | null {
  const [kind, rawNumber] = chat.split(':')
  const number = Number(rawNumber)
  if ((kind !== 'issue' && kind !== 'pr' && kind !== 'discussion') || !Number.isInteger(number) || number <= 0) {
    return null
  }
  return { kind, number }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
