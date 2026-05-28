import type { AdapterId } from './schema'

export type ChannelKey = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

// Inbound (non-text) media that the user attached to a channel message.
// The classifier produces these alongside `InboundMessage.text`; the router
// stores them and lets channel tools look them up by `id` so the agent can
// fetch / view a specific attachment without ever seeing the underlying
// platform-side `ref` (URL, file id, CDN key) in its prompt context.
//
// Design contract:
// - `id` is a 1-based index that is stable WITHIN A SINGLE inbound message
//   and assigned by the adapter classifier. It is NOT globally unique —
//   different inbounds re-use small ids (1, 2, ...). The router's lookup
//   API qualifies an id by the inbound's session + chat + author so cross-
//   message collisions cannot happen.
// - `ref` is the opaque platform handle that the adapter's
//   FetchAttachmentCallback knows how to download (Slack file id, Discord
//   CDN URL, KakaoCDN URL, Telegram file_id). It is INTENTIONALLY not
//   rendered into the user-visible prompt text — keeping it out of the
//   LLM's context prevents the dialect-confusion bug where the agent
//   pastes a malformed ref (e.g. a KakaoCDN bare key) into a tool.
// - The kind labels (photo/video/...) are coarse on purpose: they exist
//   for the prompt placeholder ("an image arrived") and for tool routing,
//   not for platform-specific behavior.
export type InboundAttachment = {
  id: number
  kind: 'photo' | 'video' | 'audio' | 'file' | 'sticker' | 'multiphoto' | 'embed'
  ref: string
  // Optional metadata that the adapter classifier may surface for the
  // placeholder rendering. Every field MUST be safe to print into a prompt
  // (no credentials, no long opaque tokens). If a piece of metadata would
  // leak fetchable state, leave it off and rely on `ref` instead.
  mimetype?: string
  filename?: string
  width?: number
  height?: number
  sizeBytes?: number
}

export type InboundMessage = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
  text: string
  // Non-text attachments the user sent on this inbound. Empty / omitted
  // when the message is text-only. The router carries these through to
  // the live session's promptQueue/contextBuffer so channel tools can
  // resolve `attachment_id` → ref without the agent ever seeing the ref.
  attachments?: readonly InboundAttachment[]
  externalMessageId: string
  authorId: string
  authorName: string
  // Set true when the inbound is from another bot (NOT this typeclaw
  // instance's own bot identity — the adapter still drops self-authored
  // messages with `reason: 'self_author'`). The router treats peer bots
  // identically to humans for engagement, but uses this flag to drive a
  // bounded loop guard so two or more bots cannot ping-pong forever.
  authorIsBot: boolean
  isBotMention: boolean
  replyToBotMessageId: string | null
  // True when the message contains at least one user mention AND none of
  // those mentions resolve to the bot. Used by the engagement layer to
  // suppress the solo-human fallback: if the human is explicitly tagging
  // someone else, the message almost certainly is not addressed to us.
  // False when the message has no mentions at all (the fallback still
  // applies in that case) or when one of the mentions IS the bot (which
  // is already handled by `isBotMention`). Adapters that cannot reliably
  // enumerate mentions MUST default this to false rather than true.
  mentionsOthers: boolean
  // Set to the parent message id when the inbound is a reply AND the
  // parent was authored by someone other than the bot (or by an unknown
  // author the adapter could not attribute). Mirrors `replyToBotMessageId`
  // but for the inverse case. Used by the engagement layer to suppress
  // the solo-human fallback on Discord-style replies that are clearly
  // directed at another user. Null when the message is not a reply, or
  // when the parent is the bot's own message (already covered by
  // `replyToBotMessageId`). Adapters that cannot determine the parent's
  // author MUST leave this null rather than guessing.
  replyToOtherMessageId: string | null
  isDm: boolean
  // Original platform-side timestamp in milliseconds since epoch. Sourced
  // from Slack's `event.ts` or Discord's `event.timestamp` (via the
  // adapter classifier), NOT the local time the router observed it. Zero
  // means "unknown" — the formatter renders such lines without a
  // timestamp prefix instead of stamping them with the wrong clock.
  ts: number
}

// File on disk that the agent wants to attach to an outbound message. The
// agent runs inside a container with /agent bind-mounted from the host;
// `path` should be an absolute path the container can `readFile`. The
// optional `filename` overrides the basename of `path` when uploading
// (useful when the on-disk name carries a tempdir suffix the user
// shouldn't see in the chat). Adapters that cannot upload files MUST
// fail loudly via `SendResult.ok = false` rather than silently dropping
// the attachment.
export type OutboundAttachment = {
  path: string
  filename?: string
}

export type OutboundMessage = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread?: string | null
  // Optional when `attachments` is non-empty (file-only post is allowed).
  // Adapters that always need text (e.g. some webhook backends in the
  // future) must validate this themselves.
  text?: string
  // Each attachment is uploaded once. Order is preserved. For Slack, the
  // first attachment carries `text` as the file's `initial_comment` so
  // both arrive in a single API call; subsequent attachments are uploaded
  // bare. For Discord, attachments are uploaded first (no text) and then
  // `text` is posted as a separate message — Discord's upstream
  // `uploadFile` does not accept a content body or a thread id, see the
  // adapter for the workaround details.
  attachments?: OutboundAttachment[]
}

export type SendErrorCode = 'duplicate' | 'turn-cap' | 'no-adapter' | 'callback-rejected' | 'skip-locked'

export type SendResult = { ok: true } | { ok: false; error: string; code?: SendErrorCode }

export type OutboundCallback = (msg: OutboundMessage) => Promise<SendResult>

export type TypingTarget = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread?: string | null
  // 'tick' is the heartbeat fired during debouncing/generation; adapters
  // should set the indicator visible. 'stop' is fired exactly once when the
  // router decides the turn is over (drain finally, /stop command, or
  // teardown); adapters should explicitly clear the indicator if their
  // platform doesn't auto-expire it. Without 'stop', a 'tick' that lands
  // after the agent's final reply but before the drain returns will leave
  // the indicator on for Slack's full 2-minute server timeout.
  phase: 'tick' | 'stop'
}

export type TypingCallback = (target: TypingTarget) => Promise<void>

export type ResolvedChannelNames = {
  chatName?: string
  workspaceName?: string
}

export type ChannelNameResolver = (key: ChannelKey) => Promise<ResolvedChannelNames>

// History entries are intentionally distinct from InboundMessage:
// `InboundMessage` carries router-classification fields (`isBotMention`,
// `isDm`) that are turn-delivery concerns, not history concerns. History
// entries instead need `isBot` so the agent can tell its own past replies
// from user messages, and a sortable `ts` for chronological rendering.
export type ChannelHistoryMessage = {
  externalMessageId: string
  authorId: string
  authorName: string
  text: string
  attachments?: readonly InboundAttachment[]
  ts: number
  isBot: boolean
  replyToBotMessageId: string | null
}

export type FetchHistoryArgs = {
  chat: string
  thread: string | null
  limit: number
  cursor?: string
}

export type FetchHistoryResult =
  | { ok: true; messages: ChannelHistoryMessage[]; nextCursor?: string }
  | { ok: false; error: string }

// Registered per-adapter on the ChannelRouter alongside outbound/typing
// callbacks. Adapters that cannot fetch history (e.g. webhook-only future
// adapters) simply do not register one; the router answers
// 'history-not-supported' for those.
export type HistoryCallback = (args: FetchHistoryArgs) => Promise<FetchHistoryResult>

export type FetchAttachmentArgs = {
  ref: string
  filename?: string
}

export type FetchAttachmentResult =
  | { ok: true; buffer: Buffer; filename: string; mimetype?: string; size: number }
  | { ok: false; error: string }

export type FetchAttachmentCallback = (args: FetchAttachmentArgs) => Promise<FetchAttachmentResult>

export function channelKeyId(key: ChannelKey): string {
  return `${key.adapter}:${key.workspace}:${key.chat}:${key.thread ?? ''}`
}
