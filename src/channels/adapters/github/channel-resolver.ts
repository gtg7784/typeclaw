import type { ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import { parseChat, parseRepo } from './outbound'

export function createGithubChannelNameResolver(options: {
  token: string
  fetchImpl?: typeof fetch
}): ChannelNameResolver {
  const fetchImpl = options.fetchImpl ?? fetch
  return async (key): Promise<ResolvedChannelNames> => {
    if (key.adapter !== 'github') return {}
    const repo = parseRepo(key.workspace)
    const chat = parseChat(key.chat)
    if (repo === null || chat === null) return {}
    const names: ResolvedChannelNames = { workspaceName: key.workspace }
    if (chat.kind === 'discussion') return names
    const path = chat.kind === 'issue' ? `issues/${chat.number}` : `pulls/${chat.number}`
    try {
      const response = await fetchImpl(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/${path}`, {
        headers: githubJsonHeaders(options.token),
      })
      if (!response.ok) return names
      const raw = (await response.json()) as { title?: string }
      return raw.title !== undefined ? { ...names, chatName: raw.title } : names
    } catch {
      return names
    }
  }
}
