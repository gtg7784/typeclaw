import type { z } from 'zod'

import { describeLeaf } from '@/plugin/zod-introspect'

import type { DiscoveredCommand } from './plugin-commands'

export function renderPluginCommandsSection(commands: readonly DiscoveredCommand[]): string | null {
  if (commands.length === 0) return null
  const lines: string[] = ['Plugin commands:']
  const namePad = Math.max(...commands.map((c) => c.commandName.length))
  for (const c of commands) {
    lines.push(`  ${c.commandName.padEnd(namePad)}    ${c.command.description}`)
  }
  return lines.join('\n')
}

export function renderCommandHelp(c: DiscoveredCommand): string {
  const lines: string[] = []
  lines.push(`typeclaw ${c.commandName} — ${c.command.description}`)
  lines.push('')
  lines.push(`  Plugin: ${c.pluginName}${c.pluginVersion !== undefined ? ` v${c.pluginVersion}` : ''}`)
  lines.push(`  Surface: ${c.command.surface}`)
  lines.push('')

  if (c.command.args === undefined) {
    lines.push('  Options:')
    lines.push('    (no options)')
    return lines.join('\n')
  }

  lines.push('  Options:')
  for (const line of renderFlags(c.command.args)) {
    lines.push(`    ${line}`)
  }
  return lines.join('\n')
}

export function renderFlags(schema: z.ZodObject<z.ZodRawShape>): string[] {
  const out: string[] = []
  const shape = schema.shape as Record<string, unknown>
  for (const [field, leaf] of Object.entries(shape)) {
    const info = describeLeaf(leaf)
    const required = info.required ? ' (required)' : ''
    const defaultPart = info.defaultValue !== undefined ? ` (default: ${info.defaultValue})` : ''
    const descPart = info.description !== undefined ? `  ${info.description}` : ''
    out.push(`--${field}=<${info.kind}>${descPart}${required}${defaultPart}`)
  }
  return out
}
