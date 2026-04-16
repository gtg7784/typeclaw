export type ClientMessage = { type: 'prompt'; text: string }

export type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; error: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }
