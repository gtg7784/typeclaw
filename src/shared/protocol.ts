export type ReloadResultPayload =
  | { scope: string; ok: true; summary: string; details?: unknown }
  | { scope: string; ok: false; reason: string }

export type PromptDelivery = 'queue' | 'steer' | 'interrupt'

export type ClientMessage =
  | { type: 'prompt'; text: string; delivery?: PromptDelivery }
  | { type: 'reload'; scope?: string }
  | { type: 'abort' }
  | { type: 'queue_cancel'; messageId: string }

export type QueueStateItem = { id: string; text: string; ts: number }

export type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; name: string; error: boolean; result: unknown; durationMs: number }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'reload_result'; results: ReloadResultPayload[] }
  | { type: 'notification'; payload: unknown; replyTo?: string; meta?: Record<string, string> }
  | { type: 'queue_state'; pending: QueueStateItem[] }
