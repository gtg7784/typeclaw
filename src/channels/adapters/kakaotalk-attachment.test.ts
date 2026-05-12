import { describe, expect, test } from 'bun:test'

import type { KakaoMessage, KakaoTalkPushEmoticonEvent } from 'agent-messenger/kakaotalk'

import {
  emoticonEventToMessageEvent,
  formatEmoticonText,
  formatHistoryText,
  formatInboundText,
} from './kakaotalk-attachment'

const emoticon = (overrides: Partial<KakaoTalkPushEmoticonEvent> = {}): KakaoTalkPushEmoticonEvent => ({
  type: 'EMOTICON',
  chat_id: '111',
  log_id: 'L1',
  author_id: 222,
  author_name: null,
  message_type: 12,
  emoticon_kind: 'sticker',
  pack_id: '4412724',
  sticker_path: '4412724.emot_001.webp',
  sent_at: 1_730_000_000_000,
  ...overrides,
})

const historyMsg = (overrides: Partial<KakaoMessage> = {}): KakaoMessage => ({
  log_id: 'L1',
  type: 1,
  author_id: 222,
  author_name: null,
  message: '',
  attachment: null,
  sent_at: 1_730_000_000_000,
  ...overrides,
})

describe('formatInboundText', () => {
  test('returns raw text unchanged for type=1 with no attachment', () => {
    expect(formatInboundText({ message: 'hello', message_type: 1, attachment: null })).toBe('hello')
  })

  test('returns empty string for empty text without attachment so classifier can still drop it', () => {
    expect(formatInboundText({ message: '', message_type: 1, attachment: null })).toBe('')
  })

  test('wraps photo (type=2) with dimensions, mime, and url so the agent has something to reason about', () => {
    const text = formatInboundText({
      message: '',
      message_type: 2,
      attachment: { k: 'abc/photo.jpg', w: 1320, h: 2868, mt: 'image/jpeg', url: 'https://talk.kakaocdn.net/p/abc' },
    })
    expect(text).toBe('[KakaoTalk message with photo 1320x2868 (image/jpeg) https://talk.kakaocdn.net/p/abc]')
  })

  test('photo without url falls back to the CDN key', () => {
    const text = formatInboundText({
      message: '',
      message_type: 2,
      attachment: { k: 'abc/photo.jpg', w: 100, h: 100, mt: 'image/jpeg' },
    })
    expect(text).toBe('[KakaoTalk message with photo 100x100 (image/jpeg) abc/photo.jpg]')
  })

  test('appends caption + summary on separate lines so caption-with-photo preserves user prose', () => {
    const text = formatInboundText({
      message: 'look at this',
      message_type: 2,
      attachment: { w: 100, h: 100, mt: 'image/jpeg', url: 'https://example.com/x.jpg' },
    })
    expect(text).toBe('look at this\n[KakaoTalk message with photo 100x100 (image/jpeg) https://example.com/x.jpg]')
  })

  test('file (type=18) renders the friendly name and size when available', () => {
    const text = formatInboundText({
      message: '',
      message_type: 18,
      attachment: { name: 'spec.pdf', mt: 'application/pdf', size: 12345, url: 'https://example.com/spec.pdf' },
    })
    expect(text).toBe(
      '[KakaoTalk message with file spec.pdf (application/pdf) size=12345 https://example.com/spec.pdf]',
    )
  })

  test('file with unknown shape falls back to a keys preview rather than dropping the payload', () => {
    const text = formatInboundText({ message: '', message_type: 18, attachment: { weirdField: 'opaque', other: 1 } })
    expect(text).toBe('[KakaoTalk message with file keys=[other,weirdField]]')
  })

  test('video (type=3) surfaces the url alongside the keys preview so the agent has a fetchable ref', () => {
    const text = formatInboundText({
      message: '',
      message_type: 3,
      attachment: { url: 'https://example.com/v.mp4', dur: 5000 },
    })
    expect(text).toBe('[KakaoTalk message with video (keys=[dur,url]) https://example.com/v.mp4]')
  })

  test('audio (type=5) surfaces the url alongside the keys preview', () => {
    const text = formatInboundText({ message: '', message_type: 5, attachment: { url: 'https://example.com/a.m4a' } })
    expect(text).toBe('[KakaoTalk message with audio (keys=[url]) https://example.com/a.m4a]')
  })

  test('multiphoto (type=27) without a url falls back to a keys-only preview', () => {
    const text = formatInboundText({ message: '', message_type: 27, attachment: { kl: ['a', 'b', 'c'] } })
    expect(text).toBe('[KakaoTalk message with multiphoto keys=[kl]]')
  })

  test('video without a url falls back to a keys-only preview rather than fabricating a ref', () => {
    const text = formatInboundText({ message: '', message_type: 3, attachment: { dur: 5000 } })
    expect(text).toBe('[KakaoTalk message with video keys=[dur]]')
  })

  test('unknown non-text type with empty message returns empty text so classifyInbound can drop it as noise', () => {
    expect(formatInboundText({ message: '', message_type: 99, attachment: { foo: 'bar' } })).toBe('')
  })

  test('unknown non-text type with caption keeps the caption verbatim without inventing a placeholder', () => {
    expect(formatInboundText({ message: 'hello', message_type: 99, attachment: { foo: 'bar' } })).toBe('hello')
  })

  test('text-type with stray attachment returns the raw text unchanged (LOCO does not mix text+attachment but we never lie about it)', () => {
    expect(formatInboundText({ message: 'hi', message_type: 1, attachment: { foo: 'bar' } })).toBe('hi')
  })
})

describe('formatEmoticonText', () => {
  test('renders sticker with pack_id and path when both are available', () => {
    expect(formatEmoticonText(emoticon())).toBe(
      '[KakaoTalk message with sticker (sticker) pack=4412724 path=4412724.emot_001.webp]',
    )
  })

  test('omits pack and path when null so we never emit dangling keys', () => {
    expect(formatEmoticonText(emoticon({ pack_id: null, sticker_path: null }))).toBe(
      '[KakaoTalk message with sticker (sticker)]',
    )
  })

  test('animated sticker carries through the emoticon_kind label', () => {
    expect(formatEmoticonText(emoticon({ emoticon_kind: 'sticker_ani', message_type: 20 }))).toBe(
      '[KakaoTalk message with sticker (sticker_ani) pack=4412724 path=4412724.emot_001.webp]',
    )
  })
})

describe('emoticonEventToMessageEvent', () => {
  test('wraps the emoticon as an MSG-shaped event so classifyInbound can route it like a normal message', () => {
    const wrapped = emoticonEventToMessageEvent(emoticon())
    expect(wrapped.type).toBe('MSG')
    expect(wrapped.chat_id).toBe('111')
    expect(wrapped.log_id).toBe('L1')
    expect(wrapped.author_id).toBe(222)
    expect(wrapped.author_name).toBeNull()
    expect(wrapped.message_type).toBe(12)
    expect(wrapped.attachment).toBeNull()
    expect(wrapped.sent_at).toBe(1_730_000_000_000)
  })

  test('synthesizes message text so classifier empty_text drop does not fire on stickers', () => {
    const wrapped = emoticonEventToMessageEvent(emoticon())
    expect(wrapped.message).toBe('[KakaoTalk message with sticker (sticker) pack=4412724 path=4412724.emot_001.webp]')
  })

  test('preserves author_name passthrough so the resolver does not need to re-lookup', () => {
    const wrapped = emoticonEventToMessageEvent(emoticon({ author_name: 'Alice' }))
    expect(wrapped.author_name).toBe('Alice')
  })
})

describe('formatHistoryText', () => {
  test('returns plain text for text-only history messages', () => {
    expect(formatHistoryText(historyMsg({ message: 'hi', type: 1 }))).toBe('hi')
  })

  test('renders photo history messages the same way as live photo events', () => {
    const text = formatHistoryText(
      historyMsg({
        type: 2,
        attachment: { w: 100, h: 100, mt: 'image/jpeg', url: 'https://example.com/x.jpg' },
      }),
    )
    expect(text).toBe('[KakaoTalk message with photo 100x100 (image/jpeg) https://example.com/x.jpg]')
  })

  test('renders historical stickers with the sticker shape derived from the attachment path', () => {
    const text = formatHistoryText(
      historyMsg({
        type: 12,
        attachment: { path: '4412724.emot_001.webp', emoticonItemPath: '4412724.emot_001.webp', name: '(emoticon)' },
      }),
    )
    expect(text).toBe('[KakaoTalk message with sticker (sticker) pack=4412724 path=4412724.emot_001.webp]')
  })

  test('falls back to the emoticonItemPath when only it is set', () => {
    const text = formatHistoryText(historyMsg({ type: 20, attachment: { emoticonItemPath: '3333.emot_009.png' } }))
    expect(text).toBe('[KakaoTalk message with sticker (sticker_ani) pack=3333 path=3333.emot_009.png]')
  })

  test('historical sticker without any path still surfaces the kind label', () => {
    const text = formatHistoryText(historyMsg({ type: 12, attachment: null }))
    expect(text).toBe('[KakaoTalk message with sticker (sticker)]')
  })
})
