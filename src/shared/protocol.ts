export type ReloadResultPayload =
  | { scope: string; ok: true; summary: string; details?: unknown }
  | { scope: string; ok: false; reason: string }

export type ClientMessage = { type: 'prompt'; text: string } | { type: 'reload'; scope?: string } | { type: 'abort' }

export type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; name: string; error: boolean; result: unknown; durationMs: number }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'reload_result'; results: ReloadResultPayload[] }
