import { findAgentDir, isInitialized } from '@/init'

import { errorLine } from './ui'

export type RequiredAgentDir = { ok: true; cwd: string } | { ok: false; message: string }

const NOT_AN_AGENT_FOLDER = 'TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'

// Operational host-stage commands (inspect, tui, logs, stop, shell, dreams) act
// on a specific agent's container or on-disk state, so they must run from inside
// an agent folder. The `findAgentDir(...) ?? startDir` fallback every caller used
// silently degraded these commands into an agent-less view — e.g. `inspect` would
// warn "container not running" and then offer only the container-logs row — instead
// of failing. Resolving to a fail result keeps the existence check explicit.
//
// Diagnostic commands (status, doctor, role list) deliberately tolerate a missing
// agent folder and must NOT use this gate.
export function resolveRequiredAgentDir(startDir: string): RequiredAgentDir {
  const cwd = findAgentDir(startDir) ?? startDir
  if (!isInitialized(cwd)) return { ok: false, message: NOT_AN_AGENT_FOLDER }
  return { ok: true, cwd }
}

export function requireAgentDir(startDir: string = process.cwd()): string {
  const result = resolveRequiredAgentDir(startDir)
  if (!result.ok) {
    console.error(errorLine(result.message))
    process.exit(1)
  }
  return result.cwd
}
