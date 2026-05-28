import {
  KAKAO_EMOTICON_KIND_BY_TYPE,
  KAKAO_MESSAGE_TYPE,
  type KakaoEmoticonKind,
  type KakaoMessage,
  type KakaoTalkPushEmoticonEvent,
  type KakaoTalkPushMessageEvent,
} from 'agent-messenger/kakaotalk'

import type { InboundAttachment } from '@/channels/types'

// Splits an inbound KakaoTalk event into (text, attachments[]). Text is
// what the agent sees in its prompt; attachments[] carries the fetchable
// `ref` (URL or file id) plus safe-to-print metadata that the router uses
// to resolve `channel_fetch_attachment` / `look_at` calls by `attachment_id`.
//
// The placeholder rendered into text is intentionally REF-FREE. Past
// regressions where the agent pasted a malformed ref (a bare KakaoCDN
// `k` key, an expired pre-signed URL, the wrong dialect across adapters)
// all stemmed from welding the ref into the prompt text. Keeping the ref
// out of the LLM's view means there is exactly ONE way to fetch an
// attachment — by its in-turn id — and the router validates that id
// against the actual inbounds, blocking hallucinated attachments by
// construction.

type InboundLike = {
  message: string
  message_type: number
  attachment: Record<string, unknown> | null
}

export type SplitInbound = {
  text: string
  attachments: InboundAttachment[]
}

export function splitInbound(event: InboundLike, startId = 1): SplitInbound {
  const rawText = event.message ?? ''
  const attachment = describeAttachment(event)
  if (attachment === null) return { text: rawText, attachments: [] }

  const id = startId
  const placeholder = renderPlaceholder(id, attachment)
  const text = rawText === '' ? placeholder : `${rawText}\n${placeholder}`
  return { text, attachments: [{ ...attachment, id }] }
}

export function splitEmoticonInbound(
  event: Pick<KakaoTalkPushEmoticonEvent, 'emoticon_kind' | 'pack_id' | 'sticker_path'>,
  startId = 1,
): SplitInbound {
  const id = startId
  const attachment = describeEmoticon(event, id)
  const placeholder = renderPlaceholder(id, attachment)
  return { text: placeholder, attachments: [attachment] }
}

export function splitHistoryInbound(message: KakaoMessage, startId = 1): SplitInbound {
  return splitInbound(
    {
      message: message.message,
      message_type: message.type,
      attachment: message.attachment,
    },
    startId,
  )
}

type DescribedAttachment = Omit<InboundAttachment, 'id'>

function describeAttachment(event: InboundLike): DescribedAttachment | null {
  switch (event.message_type) {
    case KAKAO_MESSAGE_TYPE.TEXT:
      return null
    case KAKAO_MESSAGE_TYPE.PHOTO:
      return describePhoto(event.attachment)
    case KAKAO_MESSAGE_TYPE.VIDEO:
      return describeGeneric('video', event.attachment)
    case KAKAO_MESSAGE_TYPE.AUDIO:
      return describeGeneric('audio', event.attachment)
    case KAKAO_MESSAGE_TYPE.FILE:
      return describeFile(event.attachment)
    case KAKAO_MESSAGE_TYPE.MULTIPHOTO:
      return describeGeneric('multiphoto', event.attachment)
    default:
      if (isEmoticonType(event.message_type)) {
        return describeHistoricalEmoticon(event.message_type, event.attachment)
      }
      return null
  }
}

function isEmoticonType(type: number): boolean {
  return type in KAKAO_EMOTICON_KIND_BY_TYPE
}

function describePhoto(attachment: Record<string, unknown> | null): DescribedAttachment {
  const base: DescribedAttachment = { kind: 'photo', ref: '' }
  if (attachment === null) return base
  const width = numericField(attachment, 'w')
  const height = numericField(attachment, 'h')
  const mime = stringField(attachment, 'mt')
  // Prefer the public pre-signed URL; fall back to the CDN key only as a
  // diagnostic hint in metadata, NEVER as `ref`. The bare key is not a
  // valid HTTPS URL and historically caused agents to call
  // channel_fetch_attachment with a malformed string. Without a real URL,
  // the agent will still see the placeholder ("a photo arrived") and can
  // ask the user to re-share if needed.
  const url = stringField(attachment, 'url')
  const out: DescribedAttachment = {
    ...base,
    ref: url ?? '',
    ...(mime !== null ? { mimetype: mime } : {}),
    ...(width !== null ? { width } : {}),
    ...(height !== null ? { height } : {}),
  }
  return out
}

function describeFile(attachment: Record<string, unknown> | null): DescribedAttachment {
  const base: DescribedAttachment = { kind: 'file', ref: '' }
  if (attachment === null) return base
  const name = stringField(attachment, 'name')
  const mime = stringField(attachment, 'mt')
  const size = numericField(attachment, 'size') ?? numericField(attachment, 's')
  const url = stringField(attachment, 'url')
  return {
    ...base,
    ref: url ?? '',
    ...(name !== null ? { filename: name } : {}),
    ...(mime !== null ? { mimetype: mime } : {}),
    ...(size !== null ? { sizeBytes: size } : {}),
  }
}

function describeGeneric(
  kind: 'video' | 'audio' | 'multiphoto',
  attachment: Record<string, unknown> | null,
): DescribedAttachment {
  const base: DescribedAttachment = { kind, ref: '' }
  if (attachment === null) return base
  const url = stringField(attachment, 'url')
  const mime = stringField(attachment, 'mt')
  return {
    ...base,
    ref: url ?? '',
    ...(mime !== null ? { mimetype: mime } : {}),
  }
}

function describeEmoticon(
  event: Pick<KakaoTalkPushEmoticonEvent, 'emoticon_kind' | 'pack_id' | 'sticker_path'>,
  id: number,
): InboundAttachment {
  // Stickers have no fetchable ref in the LOCO push payload; they are
  // rendered client-side from `pack_id` + `sticker_path` against a
  // packaged sprite set. Surface those as filename so the placeholder is
  // informative, and leave `ref` empty — channel_fetch_attachment will
  // refuse the lookup and tell the agent the sticker is unfetchable.
  const filename =
    event.sticker_path !== null && event.sticker_path !== '' ? event.sticker_path : `sticker-${event.emoticon_kind}`
  return {
    id,
    kind: 'sticker',
    ref: '',
    filename,
  }
}

function describeHistoricalEmoticon(
  messageType: number,
  attachment: Record<string, unknown> | null,
): DescribedAttachment {
  const kind: KakaoEmoticonKind | undefined =
    KAKAO_EMOTICON_KIND_BY_TYPE[messageType as keyof typeof KAKAO_EMOTICON_KIND_BY_TYPE]
  let filename: string | null = null
  if (attachment !== null) {
    filename = stringField(attachment, 'path') ?? stringField(attachment, 'emoticonItemPath')
  }
  return {
    kind: 'sticker',
    ref: '',
    ...(filename !== null ? { filename } : { filename: kind ?? `sticker-${messageType}` }),
  }
}

function renderPlaceholder(id: number, attachment: DescribedAttachment | InboundAttachment): string {
  const parts: string[] = [`KakaoTalk attachment #${id}: ${attachment.kind}`]
  if (attachment.width !== undefined && attachment.height !== undefined) {
    parts.push(`${attachment.width}x${attachment.height}`)
  }
  if (attachment.mimetype !== undefined) parts.push(attachment.mimetype)
  if (attachment.filename !== undefined) parts.push(`name=${attachment.filename}`)
  if (attachment.sizeBytes !== undefined) parts.push(`size=${attachment.sizeBytes}`)
  return `[${parts.join(' ')}]`
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numericField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function emoticonEventToMessageEvent(event: KakaoTalkPushEmoticonEvent): KakaoTalkPushMessageEvent {
  const { text } = splitEmoticonInbound(event)
  return {
    type: 'MSG',
    chat_id: event.chat_id,
    log_id: event.log_id,
    author_id: event.author_id,
    author_name: event.author_name,
    message: text,
    message_type: event.message_type,
    attachment: null,
    sent_at: event.sent_at,
  }
}
