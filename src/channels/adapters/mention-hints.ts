export type DiscordMentionUser = { id: string; username?: string; global_name?: string | null }

export type MentionHintOptions = { botUserId?: string | null }

// Slack encodes user mentions as `<@U…>`/`<@W…>`, optionally with a native
// `|label` fallback suffix. We capture the id and the whole token so the bare
// `<@id>` can be reconstructed (dropping any legacy label) and a resolved hint
// appended after it.
const SLACK_MENTION_PATTERN = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

// Discord uses `<@id>` and the nickname form `<@!id>`; the `!` is optional and
// irrelevant to the target user, so it is captured but discarded on rewrite.
const DISCORD_MENTION_PATTERN = /<@!?(\d+)>/g

export async function addSlackMentionHints(
  text: string,
  resolveUserName: (id: string) => Promise<string>,
  options: MentionHintOptions = {},
): Promise<string> {
  const ids = new Set<string>()
  for (const match of text.matchAll(SLACK_MENTION_PATTERN)) ids.add(match[1]!)
  if (ids.size === 0) return text

  const hints = new Map<string, string>()
  await Promise.all(
    Array.from(ids).map(async (id) => {
      const hint = resolveHint(id, await resolveUserName(id), options.botUserId)
      if (hint !== null) hints.set(id, hint)
    }),
  )

  return text.replace(SLACK_MENTION_PATTERN, (_token, id: string) => renderToken(id, hints.get(id)))
}

export function addDiscordMentionHints(
  text: string,
  usersById: Map<string, DiscordMentionUser>,
  options: MentionHintOptions = {},
): string {
  return text.replace(DISCORD_MENTION_PATTERN, (token, id: string) => {
    const user = usersById.get(id)
    const name = user === undefined ? id : (user.global_name ?? user.username ?? id)
    const hint = resolveHint(id, name, options.botUserId)
    return hint === null ? token : `${token} (${hint})`
  })
}

function resolveHint(id: string, resolvedName: string, botUserId: string | null | undefined): string | null {
  if (id === botUserId) return 'you'
  // The resolver echoes the id back when it cannot find a name; a bare id is
  // not a useful hint, so leave the token unannotated in that case.
  if (resolvedName === id || resolvedName === '') return null
  return resolvedName
}

function renderToken(id: string, hint: string | undefined): string {
  return hint === undefined ? `<@${id}>` : `<@${id}> (${hint})`
}
