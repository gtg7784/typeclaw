// First-party system tools whose EVERY argument is a control token or a remote
// identifier (channel/workspace/message/thread/cursor ids, subagent names, task
// ids, role capabilities, reload/stream scopes) — none is ever dereferenced as a
// local path. Listing the whole tool is more robust than enumerating each
// operand: these schemas gain new id/enum fields often, and every such field
// hits the same false positives (a Slack `ts` like "1699999999.000100" matches
// the `word.ext` rule; a value equal to an agent-root dir like "memory" hits the
// fs-existence probe; a base64 cursor carries a "/"). The security cost is zero
// TODAY because none reads a local file; the risk is future drift, so this set
// is the single fence, shared by BOTH enforcement points — the file-operand
// scanner (tool-file-safety) and the private-surface-read guard. It lives in
// this leaf module (no imports) so those two modules, which import each other,
// can both read it without a circular-init TDZ. Add a tool here ONLY after
// confirming it dereferences no argument as a local path.
export const TOOLS_WITHOUT_LOCAL_FILE_OPERANDS: ReadonlySet<string> = new Set([
  'channel_read',
  'channel_history',
  'channel_edit',
  'channel_react',
  'look_at_channel_attachment',
  'stream_snapshot',
  'grant_role',
  'spawn_subagent',
  'subagent_cancel',
  'subagent_output',
  'reload',
])
