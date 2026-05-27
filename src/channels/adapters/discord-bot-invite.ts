// Discord bot tokens are a JWT-shaped triple `<base64(user_id)>.<base64(ts)>.<hmac>`.
// For bot users the user id is also the application id, which is the same
// value Discord's OAuth2 authorize URL takes as `client_id`. Deriving it from
// the token the operator just pasted lets us print a ready-to-click invite
// URL without prompting separately for an application id.
//
// We intentionally keep this dependency-free and side-effect-free so it can be
// called from the host-stage CLI (`channel add`, `init`) without touching the
// agent-messenger SDK or making any network requests.

// Discord permission bits the discord-bot adapter actually exercises at
// runtime. Keep this in sync with the REST calls in discord-bot.ts —
// anything the adapter does (send, react, fetch history, register slash
// commands, attach files) needs the matching bit here, or the invite URL
// will under-grant and the bot will silently 403 in production.
//
// References:
//   https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags
const DISCORD_PERMISSIONS = {
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const

// Sum of every bit the adapter uses. BigInt because SEND_MESSAGES_IN_THREADS
// alone exceeds 2^32, so a plain `number` would silently lose precision once
// Discord adds another high bit we want.
export const DISCORD_BOT_INVITE_PERMISSIONS = Object.values(DISCORD_PERMISSIONS).reduce((acc, bit) => acc | bit, 0n)

const DISCORD_OAUTH_AUTHORIZE = 'https://discord.com/oauth2/authorize'
const DISCORD_BOT_SCOPES = ['bot', 'applications.commands'] as const

/**
 * Derive the application id (== bot user id) from a Discord bot token without
 * calling the API. Returns `null` for any token whose first segment doesn't
 * base64-decode into a snowflake — callers should treat that as "we couldn't
 * parse it, skip the invite URL hint" rather than as an invalid token, because
 * Discord reserves the right to change the token format and we'd rather
 * silently fall back than block onboarding.
 */
export function deriveAppIdFromBotToken(token: string): string | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null
  const head = segments[0]
  if (head === undefined || head.length === 0) return null
  let decoded: string
  try {
    decoded = Buffer.from(padBase64(head), 'base64').toString('utf-8')
  } catch {
    return null
  }
  // Discord snowflakes are 17-20 digit decimal strings. Reject anything that
  // doesn't look like one so we don't surface garbage as a "client_id".
  if (!/^\d{17,20}$/.test(decoded)) return null
  return decoded
}

/**
 * Build the OAuth2 invite URL Discord renders the "Add to Server" picker for.
 * Defaults to the `bot`+`applications.commands` scope pair and the permission
 * bitfield the discord-bot adapter actually needs.
 */
export function buildDiscordInviteUrl(
  appId: string,
  opts: { permissions?: bigint; scopes?: readonly string[] } = {},
): string {
  const permissions = opts.permissions ?? DISCORD_BOT_INVITE_PERMISSIONS
  const scopes = opts.scopes ?? DISCORD_BOT_SCOPES
  const params = new URLSearchParams({
    client_id: appId,
    scope: scopes.join(' '),
    permissions: permissions.toString(),
  })
  return `${DISCORD_OAUTH_AUTHORIZE}?${params.toString()}`
}

// Base64 segments inside JWT-shaped tokens omit `=` padding. Node's Buffer
// tolerates missing padding for the standard alphabet but not for url-safe,
// and we want defensive behavior either way.
function padBase64(input: string): string {
  const remainder = input.length % 4
  if (remainder === 0) return input
  return input + '='.repeat(4 - remainder)
}
