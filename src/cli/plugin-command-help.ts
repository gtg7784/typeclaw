import type { z } from 'zod'

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
    out.push(`--${field}=<${info.type}>${descPart}${required}${defaultPart}`)
  }
  return out
}

type LeafInfo = {
  type: string
  required: boolean
  defaultValue: string | undefined
  description: string | undefined
}

function describeLeaf(leaf: unknown): LeafInfo {
  let cur: unknown = leaf
  let required = true
  let defaultValue: string | undefined
  let description: string | undefined

  while (cur !== null && typeof cur === 'object') {
    const node = cur as {
      _def?: {
        type?: string
        innerType?: unknown
        defaultValue?: unknown
      }
      description?: string
    }
    const def = node._def
    if (def === undefined) break
    if (typeof node.description === 'string') description = node.description
    if (def.type === 'optional') {
      required = false
      cur = def.innerType
      continue
    }
    if (def.type === 'default') {
      required = false
      const raw = typeof def.defaultValue === 'function' ? (def.defaultValue as () => unknown)() : def.defaultValue
      defaultValue = raw === undefined ? undefined : JSON.stringify(raw)
      cur = def.innerType
      continue
    }
    if (def.type === 'nullable') {
      cur = def.innerType
      continue
    }
    return { type: toTypeName(def.type), required, defaultValue, description }
  }
  return { type: 'unknown', required, defaultValue, description }
}

function toTypeName(zodType: string | undefined): string {
  switch (zodType) {
    case 'string':
      return 'string'
    case 'number':
    case 'int':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'enum':
    case 'literal':
      return 'string'
    default:
      return 'unknown'
  }
}
