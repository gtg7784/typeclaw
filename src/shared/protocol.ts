export type ReloadResultPayload =
  | { scope: string; ok: true; summary: string; details?: unknown }
  | { scope: string; ok: false; reason: string }

export type ClientMessage = { type: 'prompt'; text: string } | { type: 'reload'; scope?: string }

export type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; error: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'reload_result'; results: ReloadResultPayload[] }
