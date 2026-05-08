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
  active_members: number
  unread_count: number
  last_message: {
    author_id: number
    message: string
    sent_at: number
  } | null
}

export type KakaoMessage = {
  log_id: string
  type: number
  author_id: number
  message: string
  sent_at: number
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

// Per the SDK source: KakaoChat.type === 0 is 1:1 (dm), 1 is normal group,
// 2 is open chat / multi-channel group. Types we don't recognize fall back
// to 'unknown' which the resolver maps to `@kakao-group` (the safest
// catch-all for engagement: groups require explicit @ to engage).
export function classifyKakaoChatType(rawType: number): KakaoChatType {
  if (rawType === 0) return 'dm'
  if (rawType === 1) return 'group'
  if (rawType === 2) return 'open'
  return 'unknown'
}

export function kakaoWorkspaceForType(type: KakaoChatType): '@kakao-dm' | '@kakao-group' | '@kakao-open' {
  if (type === 'dm') return '@kakao-dm'
  if (type === 'open') return '@kakao-open'
  return '@kakao-group'
}
