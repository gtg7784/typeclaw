import type { OutboundCallback, OutboundMessage, SendResult } from '@/channels/types'

import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'

export type GithubOutboundLogger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

export function createGithubOutboundCallback(deps: {
  token: string
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
      return await postDiscussionComment({ ...deps, fetchImpl, repo, discussionNumber: target.number, body })
    }

    const endpoint =
      target.kind === 'pr' && msg.thread !== null && msg.thread !== undefined && msg.thread !== ''
        ? `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${target.number}/comments/${encodeURIComponent(msg.thread)}/replies`
        : `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/issues/${target.number}/comments`
    return await postJson(fetchImpl, deps.token, endpoint, { body })
  }
}

async function postDiscussionComment(options: {
  token: string
  fetchImpl: typeof fetch
  repo: RepoRef
  discussionNumber: number
  body: string
}): Promise<SendResult> {
  const discussionId = await fetchDiscussionId(options)
  if (!discussionId.ok) return discussionId
  const mutation = `mutation($discussionId:ID!,$body:String!){addDiscussionComment(input:{discussionId:$discussionId,body:$body}){comment{id}}}`
  return await postGraphql(options.fetchImpl, options.token, mutation, {
    discussionId: discussionId.id,
    body: options.body,
  })
}

async function fetchDiscussionId(options: {
  token: string
  fetchImpl: typeof fetch
  repo: RepoRef
  discussionNumber: number
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){discussion(number:$number){id}}}`
  const result = await graphql<{ repository?: { discussion?: { id?: string } | null } }>(
    options.fetchImpl,
    options.token,
    query,
    {
      owner: options.repo.owner,
      name: options.repo.name,
      number: options.discussionNumber,
    },
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
): Promise<SendResult> {
  const result = await graphql(fetchImpl, token, query, variables)
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

async function graphql<T>(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(`${GITHUB_API_BASE}/graphql`, {
      method: 'POST',
      headers: githubJsonHeaders(token),
      body: JSON.stringify({ query, variables }),
    })
    const raw = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> }
    if (!response.ok || raw.errors !== undefined) {
      return {
        ok: false,
        error: raw.errors?.map((e) => e.message ?? 'unknown').join('; ') ?? `HTTP ${response.status}`,
      }
    }
    if (raw.data === undefined) return { ok: false, error: 'GraphQL response missing data' }
    return { ok: true, data: raw.data }
  } catch (err) {
    return { ok: false, error: describe(err) }
  }
}

async function postJson(fetchImpl: typeof fetch, token: string, url: string, payload: unknown): Promise<SendResult> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: githubJsonHeaders(token),
      body: JSON.stringify(payload),
    })
    if (response.ok) return { ok: true }
    const text = await response.text().catch(() => '')
    return { ok: false, error: `GitHub API ${response.status}${text !== '' ? `: ${text}` : ''}` }
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
