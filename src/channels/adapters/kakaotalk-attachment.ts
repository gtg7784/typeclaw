import {
  KAKAO_EMOTICON_KIND_BY_TYPE,
  KAKAO_MESSAGE_TYPE,
  type KakaoEmoticonKind,
  type KakaoMessage,
  type KakaoTalkPushEmoticonEvent,
  type KakaoTalkPushMessageEvent,
} from 'agent-messenger/kakaotalk'

// agent-messenger 2.15.0 added two inbound surfaces that 2.14.1 hid from
// the adapter: `KakaoTalkPushMessageEvent.attachment` (photos, files, etc.)
// and a separate `emoticon` listener event for stickers. The SDK leaves
// the `attachment` Record opaque on purpose ("treat it as opaque and
// narrow per `type`", docs/sdk/kakaotalk.mdx). For photos (type=2) the
// keys are documented (`k`, `w`, `h`, `mt`, `url`). For everything else
// (video, audio, voice, file, contact, multi-photo, ...) the SDK has
// neither test fixtures nor field documentation, so we fall back to a
// generic JSON-keys preview that still gives the agent something useful
// to reason about.
//
// The synthesized text follows the same `[KakaoTalk message with ...]`
// convention used by Slack/Discord/Telegram inbound classifiers, so the
// agent sees a consistent placeholder shape across platforms.

// Non-text inputs that the adapter accepts. We use a thin shared shape
// rather than the SDK's union so the same formatter can serve both push
// events (no `attachment` on emoticon events — emoticon fields live on
// the event itself) and history messages.
type InboundLike = {
  message: string
  message_type: number
  attachment: Record<string, unknown> | null
}

export function formatInboundText(event: InboundLike): string {
  const rawText = event.message ?? ''
  const summary = summarizeAttachment(event)
  if (summary === null) return rawText
  const wrapped = `[KakaoTalk message with ${summary}]`
  return rawText === '' ? wrapped : `${rawText}\n${wrapped}`
}

// Synthesizes the displayed text for a sticker / emoticon event. Stickers
// have no `message` field on the push event — the SDK extracts `pack_id`
// and `sticker_path` from the LOCO attachment for us, so we render those
// directly into the placeholder. Matches Discord's `sticker: name` shape
// (src/channels/adapters/discord-bot-classify.ts) but adds Kakao-specific
// fields the agent can use to disambiguate which sticker the user sent.
export function formatEmoticonText(
  event: Pick<KakaoTalkPushEmoticonEvent, 'emoticon_kind' | 'pack_id' | 'sticker_path'>,
): string {
  return `[KakaoTalk message with ${summarizeEmoticon(event)}]`
}

function summarizeAttachment(event: InboundLike): string | null {
  // Narrow to message types we know how to render. Anything else (system
  // events, deleted messages, future LOCO control packets that the SDK
  // surfaces as MSG with empty text) intentionally falls through to a
  // null summary so classifyInbound's empty_text drop fires and the
  // agent isn't woken up by phantom `[KakaoTalk message with type=N]`
  // placeholders for noise.
  switch (event.message_type) {
    case KAKAO_MESSAGE_TYPE.TEXT:
      return null
    case KAKAO_MESSAGE_TYPE.PHOTO:
      return summarizePhoto(event.attachment)
    case KAKAO_MESSAGE_TYPE.VIDEO:
      return summarizeGeneric('video', event.attachment)
    case KAKAO_MESSAGE_TYPE.AUDIO:
      return summarizeGeneric('audio', event.attachment)
    case KAKAO_MESSAGE_TYPE.FILE:
      return summarizeFile(event.attachment)
    case KAKAO_MESSAGE_TYPE.MULTIPHOTO:
      return summarizeGeneric('multiphoto', event.attachment)
    default:
      // Emoticon types route through the dedicated emoticon event before
      // they reach this function, but a history fetch can still return
      // them as plain KakaoMessage rows. Render them with the same
      // sticker shape so chronology is consistent across live and
      // history paths.
      if (isEmoticonType(event.message_type)) {
        return summarizeHistoricalEmoticon(event.message_type, event.attachment)
      }
      return null
  }
}

function isEmoticonType(type: number): boolean {
  return type in KAKAO_EMOTICON_KIND_BY_TYPE
}

function summarizePhoto(attachment: Record<string, unknown> | null): string {
  if (attachment === null) return 'photo'
  const parts = ['photo']
  const width = numericField(attachment, 'w')
  const height = numericField(attachment, 'h')
  if (width !== null && height !== null) parts.push(`${width}x${height}`)
  const mime = stringField(attachment, 'mt')
  if (mime !== null) parts.push(`(${mime})`)
  // Prefer the public URL over the CDN key — the URL is dereferenceable,
  // the key is an internal CDN path. Either is acceptable as a `ref` if
  // we ever wire fetchAttachment for photos.
  const url = stringField(attachment, 'url') ?? stringField(attachment, 'k')
  if (url !== null) parts.push(url)
  return parts.join(' ')
}

function summarizeFile(attachment: Record<string, unknown> | null): string {
  if (attachment === null) return 'file'
  const parts = ['file']
  // File attachments are not documented by the SDK; these field names are
  // best-effort common keys (`name`, `size`, `mt`, `url`) used by similar
  // protocols. If a key is absent we just omit it rather than fabricating
  // a value.
  const name = stringField(attachment, 'name')
  if (name !== null) parts.push(name)
  const mime = stringField(attachment, 'mt')
  if (mime !== null) parts.push(`(${mime})`)
  const size = numericField(attachment, 'size') ?? numericField(attachment, 's')
  if (size !== null) parts.push(`size=${size}`)
  const url = stringField(attachment, 'url')
  if (url !== null) parts.push(url)
  return parts.length === 1 ? `file ${attachmentKeysSummary(attachment)}` : parts.join(' ')
}

function summarizeGeneric(label: string, attachment: Record<string, unknown> | null): string {
  if (attachment === null) return label
  // Prefer a dereferenceable URL over a keys-only preview: the agent uses
  // the URL as the `ref` for channel_fetch_attachment, so making it visible
  // in the placeholder is what turns video/audio/multiphoto from
  // "described" into "fetchable". When the SDK hands us an opaque payload
  // with no `url` (the documented case for these types), fall back to
  // listing the available keys so we never lie about what arrived.
  const url = stringField(attachment, 'url')
  if (url !== null) return `${label} (${attachmentKeysSummary(attachment)}) ${url}`
  return `${label} ${attachmentKeysSummary(attachment)}`
}

// Last-resort renderer: list the attachment's keys so the agent at least
// knows what shape the payload had. We deliberately do NOT dump values —
// some attachment payloads contain long base64 strings or large URLs that
// would blow the agent's context window if pasted whole.
function attachmentKeysSummary(attachment: Record<string, unknown>): string {
  const keys = Object.keys(attachment).sort()
  if (keys.length === 0) return '(empty)'
  return `keys=[${keys.join(',')}]`
}

function summarizeEmoticon(
  event: Pick<KakaoTalkPushEmoticonEvent, 'emoticon_kind' | 'pack_id' | 'sticker_path'>,
): string {
  const parts = [`sticker (${event.emoticon_kind})`]
  if (event.pack_id !== null) parts.push(`pack=${event.pack_id}`)
  if (event.sticker_path !== null) parts.push(`path=${event.sticker_path}`)
  return parts.join(' ')
}

function summarizeHistoricalEmoticon(messageType: number, attachment: Record<string, unknown> | null): string {
  const kind: KakaoEmoticonKind | undefined =
    KAKAO_EMOTICON_KIND_BY_TYPE[messageType as keyof typeof KAKAO_EMOTICON_KIND_BY_TYPE]
  const parts = [`sticker (${kind ?? `type=${messageType}`})`]
  if (attachment !== null) {
    const path = stringField(attachment, 'path') ?? stringField(attachment, 'emoticonItemPath')
    if (path !== null) {
      const dotIndex = path.indexOf('.')
      const head = dotIndex > 0 ? path.slice(0, dotIndex) : null
      if (head !== null && /^\d+$/.test(head)) parts.push(`pack=${head}`)
      parts.push(`path=${path}`)
    }
  }
  return parts.join(' ')
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numericField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Wraps a KakaoTalk emoticon push event into the MSG-shaped payload that
// `classifyInbound` expects. We synthesize `message` from the sticker
// metadata so the classifier's empty-text drop doesn't fire on stickers,
// and we carry the original message_type through so a later code path
// can still distinguish stickers from text if needed.
export function emoticonEventToMessageEvent(event: KakaoTalkPushEmoticonEvent): KakaoTalkPushMessageEvent {
  return {
    type: 'MSG',
    chat_id: event.chat_id,
    log_id: event.log_id,
    author_id: event.author_id,
    author_name: event.author_name,
    message: formatEmoticonText(event),
    message_type: event.message_type,
    attachment: null,
    sent_at: event.sent_at,
  }
}

// Helper used by the history callback to convert a KakaoMessage (which
// shares the same `attachment` shape as the push event) into displayable
// text. Kept separate from `formatInboundText` so the live and history
// paths can evolve independently — e.g. history may eventually surface
// thumbnails or extra fields the push event doesn't carry.
export function formatHistoryText(message: KakaoMessage): string {
  return formatInboundText({
    message: message.message,
    message_type: message.type,
    attachment: message.attachment,
  })
}
