import { describe, expect, test } from 'bun:test'

import type { KakaoMessage, KakaoTalkPushEmoticonEvent } from 'agent-messenger/kakaotalk'

import {
  emoticonEventToMessageEvent,
  splitEmoticonInbound,
  splitHistoryInbound,
  splitInbound,
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

describe('splitInbound', () => {
  test('returns raw text unchanged for type=1 with no attachment', () => {
    expect(splitInbound({ message: 'hello', message_type: 1, attachment: null })).toEqual({
      text: 'hello',
      attachments: [],
    })
  })

  test('returns empty string for empty text without attachment so classifier can still drop it', () => {
    expect(splitInbound({ message: '', message_type: 1, attachment: null })).toEqual({ text: '', attachments: [] })
  })

  test('wraps photo with metadata while keeping the ref structured only', () => {
    const result = splitInbound({
      message: '',
      message_type: 2,
      attachment: { k: 'abc/photo.jpg', w: 1320, h: 2868, mt: 'image/jpeg', url: 'https://talk.kakaocdn.net/p/abc' },
    })
    expect(result.text).toBe('[KakaoTalk attachment #1: photo 1320x2868 image/jpeg]')
    expect(result.attachments).toEqual([
      {
        id: 1,
        kind: 'photo',
        ref: 'https://talk.kakaocdn.net/p/abc',
        mimetype: 'image/jpeg',
        width: 1320,
        height: 2868,
      },
    ])
  })

  test('photo without url drops the CDN-key fallback and leaves ref empty', () => {
    const result = splitInbound({
      message: '',
      message_type: 2,
      attachment: { k: 'abc/photo.jpg', w: 100, h: 100, mt: 'image/jpeg' },
    })
    expect(result.text).toBe('[KakaoTalk attachment #1: photo 100x100 image/jpeg]')
    expect(result.attachments[0]?.ref).toBe('')
  })

  test('appends caption + placeholder on separate lines', () => {
    const result = splitInbound({
      message: 'look at this',
      message_type: 2,
      attachment: { w: 100, h: 100, mt: 'image/jpeg', url: 'https://example.com/x.jpg' },
    })
    expect(result.text).toBe('look at this\n[KakaoTalk attachment #1: photo 100x100 image/jpeg]')
    expect(result.attachments[0]?.ref).toBe('https://example.com/x.jpg')
  })

  test('file renders name, mimetype, and size as safe metadata', () => {
    const result = splitInbound({
      message: '',
      message_type: 18,
      attachment: { name: 'spec.pdf', mt: 'application/pdf', size: 12345, url: 'https://example.com/spec.pdf' },
    })
    expect(result.text).toBe('[KakaoTalk attachment #1: file application/pdf name=spec.pdf size=12345]')
    expect(result.attachments).toEqual([
      {
        id: 1,
        kind: 'file',
        ref: 'https://example.com/spec.pdf',
        filename: 'spec.pdf',
        mimetype: 'application/pdf',
        sizeBytes: 12345,
      },
    ])
  })

  test('generic media preserves fetchable url in ref without rendering it', () => {
    const result = splitInbound({
      message: '',
      message_type: 3,
      attachment: { url: 'https://example.com/v.mp4', mt: 'video/mp4' },
    })
    expect(result.text).toBe('[KakaoTalk attachment #1: video video/mp4]')
    expect(result.attachments[0]).toEqual({
      id: 1,
      kind: 'video',
      ref: 'https://example.com/v.mp4',
      mimetype: 'video/mp4',
    })
  })

  test('generic media without a url remains visible but unfetchable', () => {
    const result = splitInbound({ message: '', message_type: 27, attachment: { kl: ['a', 'b', 'c'] } })
    expect(result.text).toBe('[KakaoTalk attachment #1: multiphoto]')
    expect(result.attachments[0]).toEqual({ id: 1, kind: 'multiphoto', ref: '' })
  })

  test('unknown non-text type with empty message returns empty text so classifyInbound can drop it as noise', () => {
    expect(splitInbound({ message: '', message_type: 99, attachment: { foo: 'bar' } })).toEqual({
      text: '',
      attachments: [],
    })
  })

  test('unknown non-text type with caption keeps the caption verbatim without inventing a placeholder', () => {
    expect(splitInbound({ message: 'hello', message_type: 99, attachment: { foo: 'bar' } })).toEqual({
      text: 'hello',
      attachments: [],
    })
  })
})

describe('splitEmoticonInbound', () => {
  test('renders sticker with filename metadata and empty ref', () => {
    expect(splitEmoticonInbound(emoticon())).toEqual({
      text: '[KakaoTalk attachment #1: sticker name=4412724.emot_001.webp]',
      attachments: [{ id: 1, kind: 'sticker', ref: '', filename: '4412724.emot_001.webp' }],
    })
  })

  test('falls back to the emoticon kind when path is absent', () => {
    expect(splitEmoticonInbound(emoticon({ pack_id: null, sticker_path: null })).attachments[0]?.filename).toBe(
      'sticker-sticker',
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
    expect(wrapped.message).toBe('[KakaoTalk attachment #1: sticker name=4412724.emot_001.webp]')
  })
})

describe('splitHistoryInbound', () => {
  test('returns plain text for text-only history messages', () => {
    expect(splitHistoryInbound(historyMsg({ message: 'hi', type: 1 }))).toEqual({ text: 'hi', attachments: [] })
  })

  test('renders photo history messages the same way as live photo events', () => {
    const result = splitHistoryInbound(
      historyMsg({ type: 2, attachment: { w: 100, h: 100, mt: 'image/jpeg', url: 'https://example.com/x.jpg' } }),
    )
    expect(result.text).toBe('[KakaoTalk attachment #1: photo 100x100 image/jpeg]')
    expect(result.attachments[0]?.ref).toBe('https://example.com/x.jpg')
  })

  test('renders historical stickers with the sticker shape derived from the attachment path', () => {
    const result = splitHistoryInbound(
      historyMsg({
        type: 12,
        attachment: { path: '4412724.emot_001.webp', emoticonItemPath: '4412724.emot_001.webp' },
      }),
    )
    expect(result.text).toBe('[KakaoTalk attachment #1: sticker name=4412724.emot_001.webp]')
    expect(result.attachments[0]).toEqual({ id: 1, kind: 'sticker', ref: '', filename: '4412724.emot_001.webp' })
  })
})
