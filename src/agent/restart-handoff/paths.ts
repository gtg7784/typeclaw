import { join } from 'node:path'

// Single source of truth for the restart-handoff file path so the writer
// (src/agent/tools/restart.ts) and the reader (src/server/index.ts) cannot
// drift. Sibling of `.typeclaw/backup-message.tmp` — same ephemeral-tenant
// pattern (write-then-read-and-delete, not gitignored, dir created on
// demand). See src/bundled-plugins/backup/subagents.ts:messageFilePath for
// the prior art.
export function restartHandoffPath(agentDir: string): string {
  return join(agentDir, '.typeclaw', 'restart-pending.json')
}
