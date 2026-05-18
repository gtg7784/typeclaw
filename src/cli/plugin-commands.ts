import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loadConfigSync } from '@/config/config'
import {
  loadPluginEntry,
  type LoadPluginEntryFn,
  type PluginCommand,
  type ResolvedPlugin,
  validateCommandDeclaration,
} from '@/plugin'

export type DiscoveredCommand = {
  pluginName: string
  pluginVersion: string | undefined
  commandName: string
  command: PluginCommand
}

export type DiscoveryResult = {
  agentDir: string
  commands: DiscoveredCommand[]
  loadErrors: { entry: string; error: string }[]
}

export type DiscoverOptions = {
  cwd: string
  loadEntry?: LoadPluginEntryFn
}

// Resolves the agent folder by walking up from cwd until typeclaw.json is
// found. Returns null when no agent folder is reachable (e.g. typeclaw run
// from a random shell prompt without an agent).
export function resolveAgentDir(cwd: string): string | null {
  let cur = cwd
  while (true) {
    if (existsSync(join(cur, 'typeclaw.json'))) return cur
    const parent = join(cur, '..')
    const resolved = normalize(parent)
    if (resolved === cur) return null
    cur = resolved
  }
}

function normalize(p: string): string {
  return p.replace(/\/+$/, '') || '/'
}

// Discovers plugin commands available to the agent at `cwd`. Loads each
// plugin module to read its static `defined.commands`, but NEVER invokes
// the plugin factory — that's a runtime concern reserved for `typeclaw run`.
//
// Returns an empty result (no error) when no agent folder is resolvable, so
// `typeclaw --help` outside any agent prints just built-ins.
//
// Side effects: `loadConfigSync(agentDir)` may rewrite `typeclaw.json` and
// commit the result when the on-disk shape is a legacy schema needing
// migration. This is by design — running ANY typeclaw subcommand should
// converge the config on the canonical shape. The migration is idempotent
// (running twice is a no-op).
export async function discoverCommands(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const agentDir = resolveAgentDir(opts.cwd)
  if (agentDir === null) {
    return { agentDir: opts.cwd, commands: [], loadErrors: [] }
  }

  let config
  try {
    config = loadConfigSync(agentDir)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { agentDir, commands: [], loadErrors: [{ entry: '<config>', error: detail }] }
  }

  const loadEntry = opts.loadEntry ?? loadPluginEntry
  const commands: DiscoveredCommand[] = []
  const loadErrors: { entry: string; error: string }[] = []
  const seenNames = new Set<string>()

  for (const entry of config.plugins) {
    let resolved: ResolvedPlugin
    try {
      resolved = await loadEntry(entry, agentDir)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      loadErrors.push({ entry, error: detail })
      continue
    }

    const declared = resolved.defined.commands
    if (declared === undefined) continue

    for (const [commandName, command] of Object.entries(declared)) {
      try {
        validateCommandDeclaration(resolved.name, commandName, command)
      } catch (err) {
        loadErrors.push({ entry, error: err instanceof Error ? err.message : String(err) })
        continue
      }
      if (seenNames.has(commandName)) {
        loadErrors.push({
          entry,
          error: `command "${commandName}" already declared by another plugin; ignoring`,
        })
        continue
      }
      seenNames.add(commandName)
      commands.push({
        pluginName: resolved.name,
        pluginVersion: resolved.version,
        commandName,
        command,
      })
    }
  }

  return { agentDir, commands, loadErrors }
}
