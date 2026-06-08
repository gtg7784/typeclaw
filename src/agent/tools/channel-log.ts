// Shared logger surface for the channel_* agent tools.
//
// Until now, the channel tools (channel_send / channel_reply /
// channel_history / channel_fetch_attachment / channel_disengage / ...)
// swallowed every failure into the model-visible
// tool result and emitted nothing to the container's stdout/stderr. That
// made operator-side debugging blind: a Slack send that 403'd, a
// `thread-scope-requires-thread-session` denial, or a Discord attachment
// fetch that timed out left no trace in `typeclaw logs`. The router layer
// logs some of these (e.g. `fetchHistory` warns on caught exceptions) but
// does NOT log `router.send` rejections, and pre-router validation errors
// inside the tools (missing text, NO_REPLY misuse, thread-scope mismatch,
// local write failures) never reached the router in the first place.
//
// One injectable logger per tool keeps the existing fake-router test
// pattern intact: tests pass an array-collecting logger to assert the log
// line, production code defaults to `consoleChannelLogger` which routes to
// `console.warn` so it lands in `typeclaw logs` alongside the existing
// `[channels]` lines from manager.ts / router.ts.
export type ChannelToolLogger = {
  warn: (msg: string) => void
}

export const consoleChannelLogger: ChannelToolLogger = {
  warn: (m) => console.warn(m),
}

// Format a failure log line. Keeps the `[channels]` prefix used by
// manager.ts and router.ts so operators can `grep '\[channels\]'` and see
// the full stack of channel-related warnings in one pass.
export function formatChannelToolFailure(tool: string, error: string): string {
  return `[channels] ${tool} failed: ${error}`
}
