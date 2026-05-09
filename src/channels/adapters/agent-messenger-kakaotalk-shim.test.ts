import { describe, expect, test } from 'bun:test'

import { classifyKakaoChat, kakaoWorkspaceForType, type KakaoChat } from './agent-messenger-kakaotalk-shim'

const chat = (overrides: Partial<KakaoChat>): KakaoChat => ({
  chat_id: '1',
  type: 11,
  display_name: 'Counterparty',
  active_members: 2,
  unread_count: 0,
  last_message: null,
  ...overrides,
})

describe('classifyKakaoChat', () => {
  test('classifies a modern 1:1 DM (t=11, members=2) as dm', () => {
    expect(classifyKakaoChat(chat({ type: 11, active_members: 2 }))).toBe('dm')
  })

  test('classifies a modern group (t=10, members=5) as group', () => {
    expect(classifyKakaoChat(chat({ type: 10, active_members: 5 }))).toBe('group')
  })

  test('classifies a 2-person normal chat as dm regardless of type code', () => {
    // Real-world LOCO emits a variety of codes for 2-member normal chats
    // depending on how the chat was created (legacy vs modern, opened from
    // group vs friend list). All of them should bucket as `dm` — the bug
    // we are guarding against was misclassifying these as `@kakao-group`.
    for (const t of [0, 1, 10, 11]) {
      expect(classifyKakaoChat(chat({ type: t, active_members: 2 }))).toBe('dm')
    }
  })

  test('classifies a memo / note-to-self chat (members=1) as dm', () => {
    expect(classifyKakaoChat(chat({ type: 9, active_members: 1 }))).toBe('dm')
  })

  test('classifies OpenChat-flavored chats by type code, not member count', () => {
    for (const t of [2, 13, 14, 15, 16]) {
      expect(classifyKakaoChat(chat({ type: t, active_members: 2 }))).toBe('open')
      expect(classifyKakaoChat(chat({ type: t, active_members: 50 }))).toBe('open')
    }
  })

  test('classifies a chat with 3+ members as group when type is not OpenChat', () => {
    expect(classifyKakaoChat(chat({ type: 10, active_members: 3 }))).toBe('group')
    expect(classifyKakaoChat(chat({ type: 1, active_members: 100 }))).toBe('group')
  })
})

describe('kakaoWorkspaceForType', () => {
  test('maps each kind to its workspace label', () => {
    expect(kakaoWorkspaceForType('dm')).toBe('@kakao-dm')
    expect(kakaoWorkspaceForType('group')).toBe('@kakao-group')
    expect(kakaoWorkspaceForType('open')).toBe('@kakao-open')
  })

  test('falls back to @kakao-group for unknown', () => {
    expect(kakaoWorkspaceForType('unknown')).toBe('@kakao-group')
  })
})
