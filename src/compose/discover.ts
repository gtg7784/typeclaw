import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { containerNameFromCwd } from '@/container'
import { isInitialized } from '@/init'

export type AgentEntry = {
  name: string
  cwd: string
  containerName: string
}

// One-depth scan: lists immediate subdirectories of `rootCwd`, keeps the ones
// that contain a typeclaw.json, and skips dot-prefixed names (.git, .vscode,
// node_modules-style hidden dirs are not skipped because they don't match the
// dot-prefix rule, but they also won't pass the typeclaw.json filter).
//
// Underscore-prefixed names are also skipped so operators can park a disabled
// or in-progress agent next to live ones (e.g. `_archived-coder/`) without
// compose touching it.
//
// Returns an empty array when rootCwd doesn't exist or is empty — discovery is
// not the place to fail; the caller decides what to do with zero agents.
//
// Sort by name so output across operations (up/down/ps/restart/logs) is
// deterministic regardless of filesystem readdir order.
export function discoverAgents(rootCwd: string): AgentEntry[] {
  const root = resolve(rootCwd)
  let entries: { name: string; isDir: boolean }[]
  try {
    entries = readdirSync(root, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() }))
  } catch {
    return []
  }

  const agents: AgentEntry[] = []
  for (const entry of entries) {
    if (!entry.isDir) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('_')) continue
    const cwd = join(root, entry.name)
    if (!isInitialized(cwd)) continue
    agents.push({ name: entry.name, cwd, containerName: containerNameFromCwd(cwd) })
  }

  agents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return agents
}
