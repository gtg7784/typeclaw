import type { CommandInfo } from '@/commands'

// Generated from registry metadata so the listing can never drift from the
// actual command set. The `/` prefix is canonical across every surface; Slack
// threads accept the `!` alias for the same names.
export function formatChannelCommandHelp(commands: readonly CommandInfo[]): string {
  if (commands.length === 0) return 'No commands are available.'
  const lines = commands.map((command) => `/${command.name} — ${command.description}`)
  return ['Available commands:', ...lines].join('\n')
}
