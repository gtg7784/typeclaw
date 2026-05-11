// Insulates our code from agent-messenger's strict-mode upstream TS source
// (no `dist/` declarations on npm yet) by re-exporting under a type-augmented
// surface. Runtime uses the real package; TypeScript sees our richer types.
//
// DELETE WHEN: agent-messenger publishes `dist/platforms/kakaotalk/
// index.d.ts`. Drop this file and import directly from
// 'agent-messenger/kakaotalk' in adapters/kakaotalk.ts.

import {
  KakaoCredentialManager as RawCredentialManager,
  KakaoTalkClient as RawClient,
  KakaoTalkListener as RawListener,
} from 'agent-messenger/kakaotalk'

export type KakaoChatType = 'dm' | 'group' | 'open' | 'unknown'

export type KakaoChat = {
  chat_id: string
  type: number
  display_name: string | null
  // Always null on our default getChats() path — populating it costs one
  // CHATINFO call per chat (plus one INFOLINK per untitled open chat),
  // which we don't pay at refresh time. display_name covers channel-tag
  // rendering well enough that the extra round trips aren't justified.
  title: string | null
  active_members: number
  unread_count: number
  last_message: {
    author_id: number
    author_name: string | null
    message: string
    sent_at: number
  } | null
}

export type KakaoMessage = {
  log_id: string
  type: number
  author_id: number
  // Free resolution covers only the chat-list's "display members" (~5 per
  // room); larger groups need an explicit getMembers() call to fill in
  // the rest. createKakaoAuthorResolver handles that fallback.
  author_name: string | null
  message: string
  sent_at: number
}

export type KakaoMember = {
  user_id: string
  nickname: string
  profile_image_url: string | null
  full_profile_image_url: string | null
  original_profile_image_url: string | null
  status_message: string | null
  country_iso: string | null
  user_type: number | null
  open_token: number | null
  open_profile_link_id: string | null
  // Bitfield: 1=OWNER, 2=NONE, 4=MANAGER, 8=BOT. Null on normal chats.
  open_permission: number | null
}

export type KakaoSendResult = {
  success: boolean
  status_code: number
  chat_id: string
  log_id: string
  sent_at: number
}

export type KakaoProfile = {
  user_id: string
  nickname: string
  status_message: string | null
}

export type KakaoTalkPushMessageEvent = {
  type: 'MSG'
  chat_id: string
  log_id: string
  author_id: number
  author_name: string | null
  message: string
  message_type: number
  sent_at: number
}

export type KakaoTalkPushMemberEvent = {
  type: 'NEWMEM' | 'DELMEM'
  chat_id: string
  member: { user_id: number }
}

export type KakaoTalkListenerConnected = {
  userId: string
}

export type KakaoTalkListenerEventMap = {
  message: [event: KakaoTalkPushMessageEvent]
  member_joined: [event: KakaoTalkPushMemberEvent]
  member_left: [event: KakaoTalkPushMemberEvent]
  connected: [info: KakaoTalkListenerConnected]
  disconnected: []
  error: [error: Error]
}

export type KakaoCredentials = {
  oauthToken: string
  userId: string
  deviceUuid?: string
  deviceType?: 'pc' | 'tablet'
}

export interface KakaoTalkClient {
  login(credentials?: KakaoCredentials, accountId?: string): Promise<this>
  getChats(options?: { all?: boolean; search?: string }): Promise<KakaoChat[]>
  getMessages(chatId: string, options?: { count?: number; from?: string }): Promise<KakaoMessage[]>
  sendMessage(chatId: string, text: string): Promise<KakaoSendResult>
  getProfile(): Promise<KakaoProfile>
  getMembers(chatId: string): Promise<KakaoMember[]>
  lookupAuthorName(chatId: string, authorId: number): string | null
  close(): void
}

export interface KakaoTalkListener {
  start(): Promise<void>
  stop(): void
  on<K extends keyof KakaoTalkListenerEventMap>(
    event: K,
    listener: (...args: KakaoTalkListenerEventMap[K]) => void,
  ): this
  off<K extends keyof KakaoTalkListenerEventMap>(
    event: K,
    listener: (...args: KakaoTalkListenerEventMap[K]) => void,
  ): this
}

export type KakaoStoredAccount = {
  account_id: string
  user_id: string
  oauth_token: string
  refresh_token?: string
  device_uuid: string
  device_type: 'pc' | 'tablet'
}

export type KakaoPendingLoginState = {
  device_uuid: string
  device_type: 'pc' | 'tablet'
  email: string
  created_at: string
}

export type KakaoAccountToPersist = {
  account_id: string
  user_id: string
  oauth_token: string
  refresh_token?: string
  device_uuid: string
  device_type: 'pc' | 'tablet'
  auth_method: 'login' | 'extract'
  created_at: string
  updated_at: string
}

export interface KakaoCredentialManager {
  getAccount(id?: string): Promise<(KakaoStoredAccount & { auth_method?: 'login' | 'extract' }) | null>
  setAccount(account: KakaoAccountToPersist): Promise<void>
  setCurrentAccount(id: string): Promise<void>
  loadPendingLogin(): Promise<KakaoPendingLoginState | null>
  clearPendingLogin(): Promise<void>
}

export const KakaoTalkClient = RawClient as unknown as new () => KakaoTalkClient
export const KakaoTalkListener = RawListener as unknown as new (client: KakaoTalkClient) => KakaoTalkListener
export const KakaoCredentialManager = RawCredentialManager as unknown as new (
  configDir?: string,
) => KakaoCredentialManager

// LOCO type codes that denote OpenChat-style chats (1:1 OpenChat, multi
// OpenChat, etc.) sourced from reverse-engineered LOCO clients. Member
// count CANNOT substitute here — 1:1 OpenChats exist and are semantically
// distinct from normal DMs (different identity, different policy, etc.).
const OPEN_CHAT_TYPE_CODES: ReadonlySet<number> = new Set([2, 13, 14, 15, 16])

// REGRESSION GUARD: an earlier implementation hard-coded `0=dm, 1=group,
// 2=open` on the raw type number. Modern KakaoTalk uses codes like `11`
// for normal DMs and `10` for normal groups, so the old mapping silently
// classified every real DM as 'unknown' → bucket `@kakao-group`, making
// `kakao:dm/*` allow rules unmatchable. Do not "simplify" back to a pure
// type-code mapping without verifying against a real KakaoTalk session.
export function classifyKakaoChat(chat: Pick<KakaoChat, 'type' | 'active_members'>): KakaoChatType {
  if (OPEN_CHAT_TYPE_CODES.has(chat.type)) return 'open'
  if (chat.active_members <= 2) return 'dm'
  return 'group'
}

export { kakaoWorkspaceForType } from './kakaotalk-channel-resolver'
