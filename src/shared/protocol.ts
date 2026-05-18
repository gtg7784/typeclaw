export type ReloadResultPayload =
  | { scope: string; ok: true; summary: string; details?: unknown }
  | { scope: string; ok: false; reason: string }

export type PromptDelivery = 'queue' | 'steer' | 'interrupt'

export type DoctorRequestId = string

export type DoctorCheckPayload = {
  id: string
  pluginName: string
  checkName: string
  description: string
  category: string
  status: 'ok' | 'warning' | 'error'
  message: string
  details?: string[]
  fix?: { description: string; hasApply: boolean }
}

export type DoctorFixPayload =
  | { ok: true; checkId: string; summary: string; changedPaths: string[] }
  | { ok: false; checkId: string; error: string }

export type ClaimRoleChoice = 'owner' | 'member' | 'trusted' | (string & {})

export type TunnelRequestId = string

export type TunnelSnapshot = {
  name: string
  provider: 'external' | 'cloudflare-quick'
  for: { kind: 'channel'; name: string } | { kind: 'manual' }
  url: string | null
  status: 'stopped' | 'starting' | 'healthy' | 'unhealthy' | 'permanently-failed'
  lastUrlAt: number | null
  detail: string
}

export type TunnelLogsClientMessage = { type: 'subscribe'; name: string; follow: boolean }

export type TunnelLogsServerMessage =
  | { type: 'snapshot'; lines: string[] }
  | { type: 'line'; line: string }
  | { type: 'error'; message: string }
  | { type: 'end' }

export type ClientMessage =
  | { type: 'prompt'; text: string; delivery?: PromptDelivery }
  | { type: 'reload'; scope?: string }
  | { type: 'abort' }
  | { type: 'queue_cancel'; messageId: string }
  | { type: 'doctor'; requestId: DoctorRequestId }
  | { type: 'doctor_fix'; requestId: DoctorRequestId; checkId: string }
  | { type: 'cron_list'; requestId: CronListRequestId }
  | { type: 'tunnel_list_request'; requestId: TunnelRequestId }
  | { type: 'tunnel_status_request'; requestId: TunnelRequestId; name: string }
  | { type: 'claim_start'; code: string; role: ClaimRoleChoice; channel?: string; ttlMs: number }
  | { type: 'claim_cancel' }
  | {
      type: 'exec_command'
      callId: string
      name: string
      args: unknown
      isolated?: boolean
      // Parent origin to stamp as spawnedByOrigin on the command's session.
      // When unset, the runner stamps a synthetic TUI origin (host CLI
      // operator). When set, the runner trusts the JSON verbatim as a
      // SessionOrigin (e.g. cron-shaped, carrying scheduledByRole).
      // Permission resolution chases through to the parent origin's role.
      parentOriginJson?: string
    }
  | { type: 'command_stdin'; callId: string; chunk: string }
  | { type: 'command_stdin_end'; callId: string }
  | { type: 'command_abort'; callId: string; reason: string }

export type CronListRequestId = string

export type CronListSourcePayload = { kind: 'user' } | { kind: 'plugin'; pluginName: string; localId: string }

export type CronListEntryPayload = {
  id: string
  source: CronListSourcePayload
  kind: 'prompt' | 'exec' | 'handler'
  schedule: string
  timezone?: string
  enabled: boolean
  scheduledByRole?: string
  nextFireMs: number | null
  scheduleError?: string
  prompt?: string
  subagent?: string
  command?: readonly string[]
}

export type CronListResultPayload =
  | { ok: true; jobs: CronListEntryPayload[]; nowMs: number }
  | { ok: false; reason: string }

export type QueueStateItem = { id: string; text: string; ts: number }

export type ClaimStartedPayload = {
  code: string
  role: string
  channel?: string
  expiresAt: number
}

export type ClaimCompletedPayload = {
  code: string
  role: string
  matchRule: string
  adapter: string
  authorId: string
}

export type ClaimErrorPayload = {
  code: string
  reason: string
}

export type ServerMessage =
  // serverVersion is optional so an old CLI talking to a new server still
  // parses cleanly. The server impl always emits it; consumers that care
  // about host/agent skew (the TUI command in particular) read it to warn
  // the user when their CLI is on a different version than the container.
  | { type: 'connected'; sessionId: string; serverVersion?: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; name: string; error: boolean; result: unknown; durationMs: number }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'reload_result'; results: ReloadResultPayload[] }
  | { type: 'notification'; payload: unknown; replyTo?: string; meta?: Record<string, string> }
  | { type: 'queue_state'; pending: QueueStateItem[] }
  | { type: 'prompt_started'; messageId: string; text: string }
  | { type: 'doctor_result'; requestId: DoctorRequestId; checks: DoctorCheckPayload[] }
  | { type: 'doctor_fix_result'; requestId: DoctorRequestId; result: DoctorFixPayload }
  | { type: 'cron_list_result'; requestId: CronListRequestId; result: CronListResultPayload }
  | ({ type: 'tunnel_list_response'; requestId: TunnelRequestId } & (
      | { ok: true; tunnels: TunnelSnapshot[] }
      | { ok: false; error: string }
    ))
  | ({ type: 'tunnel_status_response'; requestId: TunnelRequestId } & (
      | { ok: true; tunnel: TunnelSnapshot }
      | { ok: false; error: string }
    ))
  | { type: 'claim_started'; payload: ClaimStartedPayload }
  | { type: 'claim_completed'; payload: ClaimCompletedPayload }
  | { type: 'claim_error'; payload: ClaimErrorPayload }
  | { type: 'command_stdout'; callId: string; chunk: string }
  | { type: 'command_stderr'; callId: string; chunk: string }
  | { type: 'command_exit'; callId: string; code: number }
  | { type: 'command_error'; callId: string; message: string }
