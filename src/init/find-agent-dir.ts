import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Dependency-free agent-folder resolution. Kept out of `src/init/index.ts` so
// the host CLI entry (`src/cli/index.ts`) can locate the agent folder at the
// dispatch boundary WITHOUT pulling in the heavy init barrel (which statically
// imports @/config, @/config/providers, @/container, @/secrets, @/tui — a
// ~190ms module graph). This module MUST NOT import from the init barrel,
// config, container, or plugin modules; keep the dependency direction one-way.

export const CONFIG_FILE = 'typeclaw.json'

export function isInitialized(dir: string): boolean {
  return existsSync(join(dir, CONFIG_FILE))
}

// Walks upward from `start` looking for the agent folder (the dir containing
// typeclaw.json). Returns the found dir, or null if nothing is found before
// the walk hits a stop boundary.
//
// Stop boundaries (whichever comes first, checked at every level):
//   1. The current dir contains typeclaw.json — return it.
//   2. The current dir contains .git — return null. A .git boundary marks a
//      project root; refusing to cross it prevents accidentally picking up an
//      unrelated parent project, and matches how typeclaw itself initializes
//      one .git per agent folder.
//   3. We've reached the filesystem root — return null.
//
// The `.git` check fires AFTER the typeclaw.json check at the same level so
// that walking up from a subdir of the agent (e.g. `<agent>/workspace/`) still
// resolves to the agent root, even though the agent root itself contains both
// typeclaw.json and .git.
export function findAgentDir(start: string): string | null {
  let dir = resolve(start)
  const root = resolve(dir, '/')
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir
    if (existsSync(join(dir, '.git'))) return null
    if (dir === root) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
