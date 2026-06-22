import type {
  MembershipCount,
  MembershipResolver,
  MembershipResolverFailure,
  MembershipResolverResult,
} from '../membership'
import type { KakaoTalkClient } from './kakaotalk'

export type KakaoMembershipResolverOptions = {
  client: Pick<KakaoTalkClient, 'getMembers'>
  // The logged-in agent's own KakaoTalk user_id. Returned by `getMembers`
  // alongside every human in the room, so it must be excluded from the
  // human count — otherwise a 1:1 chat (agent + one human) reports two
  // humans and a real group is off by one. Null before login completes,
  // in which case we cannot prove self-exclusion and fail closed.
  selfUserIdRef: () => string | null
  logger: { warn: (msg: string) => void }
  now?: () => number
}

// Without a registered resolver the router's `resolveEffectiveHumans` falls
// back to `persistedHumans` — only humans who already posted in the live
// session. On a cold-started group that is just the sender, tripping the
// engagement layer's solo-human "answer everything" fallback so the agent
// replies to messages aimed at others. Every other adapter registers a
// resolver; KakaoTalk was the lone gap. `getMembers` returns the COMPLETE
// active roster (agent-messenger merges the GETMEM subset with the CHATONROOM
// full list), so unlike Telegram's opaque count we report it as non-truncated.
// Room rosters list only human accounts plus the agent's own; hence
// `humans = roster excluding self` and `bots: 1` (the agent) — `bots: 0` would
// defeat the engagement layer's peer-bot loop suppression.
export function createKakaoMembershipResolver(options: KakaoMembershipResolverOptions): MembershipResolver {
  const now = options.now ?? Date.now
  return async (key): Promise<MembershipResolverResult> => {
    if (key.adapter !== 'kakaotalk') return { kind: 'permanent' } satisfies MembershipResolverFailure
    const selfUserId = options.selfUserIdRef()
    if (selfUserId === null) {
      // Pre-login: we cannot exclude ourselves from the roster, so any count
      // would over-report humans by one. Fail transient so the router keeps
      // its `persistedHumans` fallback and retries once we have identity.
      return { kind: 'transient' } satisfies MembershipResolverFailure
    }
    try {
      const members = await options.client.getMembers(key.chat)
      // Dedupe by user_id — a merged GETMEM+CHATONROOM roster can list the
      // same member twice when both sources carry them.
      const memberIds = new Set<string>()
      for (const m of members) memberIds.add(m.user_id)
      memberIds.delete(selfUserId)
      const humanMemberIds = [...memberIds]
      return {
        humans: humanMemberIds.length,
        bots: 1,
        fetchedAt: now(),
        truncated: false,
        humanMemberIds,
      } satisfies MembershipCount
    } catch (err) {
      options.logger.warn(`[kakaotalk] membership chat=${key.chat} failed: ${describe(err)}`)
      return { kind: 'transient' } satisfies MembershipResolverFailure
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
