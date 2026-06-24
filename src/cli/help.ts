import { type CommandDef, renderUsage } from 'citty'

import { CLI_VERSION } from '../init/cli-version'
import { BUILTIN_COMMANDS } from './command-meta'

// Reuses citty's own renderUsage for byte-identical output, but feeds it static
// `{ meta }` subcommands instead of the lazy import-thunks the real `main` uses.
// renderUsage only reads each subcommand's `meta` (name/description/hidden), so
// these stand-ins render the same table WITHOUT importing the 25 command modules
// — the resolve-all-for-help path was the startup-cost regression this fixes.
function buildHelpCommand(): CommandDef {
  const subCommands: Record<string, CommandDef> = {}
  for (const { name, description, hidden } of BUILTIN_COMMANDS) {
    subCommands[name] = { meta: { name, description, ...(hidden === true ? { hidden: true } : {}) } }
  }
  return {
    meta: { name: 'typeclaw', version: CLI_VERSION, description: 'TypeClaw agent runtime' },
    subCommands,
  }
}

export async function renderTopLevelUsage(): Promise<string> {
  return renderUsage(buildHelpCommand())
}
