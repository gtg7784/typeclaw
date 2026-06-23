import { BUILTIN_COMMAND_NAMES } from './builtins'

export const UPDATE_CHECK_COMMAND = '_update-check'

// Commands for which an update nudge would be noise or out of place: the
// container stage (`run`), the hidden internals, and `update` itself (the user
// is already updating). Bare flags are filtered separately by the `-` prefix.
const SUPPRESSED_COMMANDS = new Set(['run', 'update', '_hostd', UPDATE_CHECK_COMMAND])

// Dependency-free on purpose: index.ts calls this BEFORE importing the rest of
// the update-notify path so a suppressed command (bare flag, plugin command,
// `run`) never pays the eager `@/config` load that module triggers. Keep this
// file's imports limited to the builtin-name list.
export function shouldConsiderUpdateNotice(commandName: string | undefined): boolean {
  if (commandName === undefined) return false
  if (commandName.startsWith('-')) return false
  if (SUPPRESSED_COMMANDS.has(commandName)) return false
  return BUILTIN_COMMAND_NAMES.includes(commandName as (typeof BUILTIN_COMMAND_NAMES)[number])
}
