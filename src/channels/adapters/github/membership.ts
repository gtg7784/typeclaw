import type { MembershipResolver, MembershipResolverResult } from '@/channels/membership'

import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import { parseRepo } from './outbound'

export function createGithubMembershipResolver(options: {
  token: (context?: GithubAuthContext) => Promise<string>
  fetchImpl?: typeof fetch
}): MembershipResolver {
  const fetchImpl = options.fetchImpl ?? fetch
  return async (key): Promise<MembershipResolverResult> => {
    if (key.adapter !== 'github') return { kind: 'permanent' }
    const repo = parseRepo(key.workspace)
    if (repo === null) return { kind: 'permanent' }
    try {
      const response = await fetchImpl(
        `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/collaborators?per_page=100`,
        {
          headers: githubJsonHeaders(await options.token({ repoSlug: key.workspace })),
        },
      )
      if (!response.ok) return response.status >= 500 ? { kind: 'transient' } : { kind: 'permanent' }
      const users = (await response.json()) as Array<{ type?: string; id?: number }>
      const truncated = users.length >= 100
      let bots = 0
      let humans = 0
      const humanMemberIds: string[] = []
      let everyHumanIdentified = true
      for (const user of users) {
        if (user.type === 'Bot') {
          bots++
          continue
        }
        humans++
        // Inbound GitHub turns key authorId on the numeric user id (see
        // inbound.ts), so the resolvable identity is `String(id)`, not `login`.
        if (user.id === undefined) everyHumanIdentified = false
        else humanMemberIds.push(String(user.id))
      }
      // Identities are a completeness proof; only attach them on a full,
      // fully-identified enumeration. A truncated page or an unidentifiable
      // collaborator drops back to counts-only so consumers fail closed.
      return truncated || !everyHumanIdentified
        ? { humans, bots, fetchedAt: Date.now(), truncated }
        : { humans, bots, fetchedAt: Date.now(), truncated, humanMemberIds }
    } catch {
      return { kind: 'transient' }
    }
  }
}
