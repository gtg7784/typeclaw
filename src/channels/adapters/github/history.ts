import type { ChannelHistoryMessage, FetchHistoryArgs, FetchHistoryResult, HistoryCallback } from '@/channels/types'

import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import { parseChat, parseRepo } from './outbound'

export function createGithubHistoryCallback(options: {
  token: string
  workspaceForChat: (chat: string) => string | null
  fetchImpl?: typeof fetch
}): HistoryCallback {
  const fetchImpl = options.fetchImpl ?? fetch
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const workspace = options.workspaceForChat(args.chat)
    if (workspace === null)
      return { ok: false, error: 'github history unavailable until this chat receives an inbound' }
    const repo = parseRepo(workspace)
    const chat = parseChat(args.chat)
    if (repo === null || chat === null) return { ok: false, error: 'invalid github history target' }
    if (chat.kind === 'discussion') return { ok: false, error: 'github discussion history not supported yet' }
    const endpoint =
      chat.kind === 'pr' && args.thread !== null
        ? `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${chat.number}/comments`
        : `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/issues/${chat.number}/comments`
    try {
      const cursor = args.cursor !== undefined && args.cursor !== '' ? `&page=${encodeURIComponent(args.cursor)}` : ''
      const response = await fetchImpl(
        `${endpoint}?per_page=${Math.min(Math.max(args.limit, 1), 100)}&direction=desc${cursor}`,
        {
          headers: githubJsonHeaders(options.token),
        },
      )
      if (!response.ok) return { ok: false, error: `GitHub history ${response.status}` }
      const raw = (await response.json()) as GithubComment[]
      const link = response.headers.get('link') ?? ''
      const nextCursor = /[?&]page=(\d+)[^>]*>; rel="next"/.exec(link)?.[1]
      return nextCursor !== undefined
        ? { ok: true, messages: raw.map(mapComment), nextCursor }
        : { ok: true, messages: raw.map(mapComment) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

type GithubComment = {
  id: number
  body?: string
  created_at?: string
  user?: { id?: number; login?: string; type?: string }
}

function mapComment(comment: GithubComment): ChannelHistoryMessage {
  const login = comment.user?.login ?? 'unknown'
  return {
    externalMessageId: String(comment.id),
    authorId: String(comment.user?.id ?? login),
    authorName: login,
    text: comment.body ?? '',
    ts: comment.created_at !== undefined ? Date.parse(comment.created_at) || 0 : 0,
    isBot: comment.user?.type === 'Bot',
    replyToBotMessageId: null,
  }
}
