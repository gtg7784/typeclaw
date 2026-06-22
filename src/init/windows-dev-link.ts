import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared/platform'

const NODE_MODULES = 'node_modules'
const TYPECLAW_DEP = 'typeclaw'

export type RunBunLink = (cwd: string) => Promise<void>

export type LinkWindowsDevTypeclawOptions = {
  platform?: NodeJS.Platform
  runBunLink?: RunBunLink
  env?: NodeJS.ProcessEnv
}

// Mirrors Bun's `openGlobalDir` env-var precedence (BUN_INSTALL_GLOBAL_DIR >
// BUN_INSTALL/install/global > XDG_CACHE_HOME/bun/install/global >
// homedir/.bun/install/global) so we resolve the same global-link location Bun
// writes to. The node_modules/<name> entry is a junction (Windows) or symlink
// (POSIX) whose target is the checkout absolute path; realpathSync resolves both.
export function resolveBunLinkedPackage(packageName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const globalDir =
    env.BUN_INSTALL_GLOBAL_DIR ??
    (env.BUN_INSTALL ? join(env.BUN_INSTALL, 'install', 'global') : null) ??
    (env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, 'bun', 'install', 'global') : null) ??
    join(homedir(), '.bun', 'install', 'global')
  try {
    return realpathSync(join(globalDir, NODE_MODULES, packageName))
  } catch {
    return null
  }
}

// Native-Windows dev-mode only: register the typeclaw checkout via `bun link` so
// the agent can depend on it as `link:typeclaw`. `link:` resolves to a
// symlink/junction that bun's installer SKIPS entirely (no `.folder` verify,
// no uninstall-before-install, no source-tree copy) — unlike `file:`, which
// copies the whole checkout incl `.git/` and EPERMs on locked git files (the
// #899 path). Returns the linked target path (for the container bind-mount) or
// null when not Windows. POSIX keeps `file:` (registry users use a version spec
// and never reach here).
export async function linkWindowsDevTypeclaw(
  typeclawRoot: string,
  options: LinkWindowsDevTypeclawOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  if (!isWindows(platform)) return null
  const runLink = options.runBunLink ?? defaultRunBunLink
  await runLink(typeclawRoot)
  return resolveBunLinkedPackage(TYPECLAW_DEP, options.env ?? process.env) ?? typeclawRoot
}

async function defaultRunBunLink(cwd: string): Promise<void> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) throw new Error('bun runtime not available to run `bun link`')
  const proc = bun.spawn({ cmd: ['bun', 'link'], cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`bun link failed in ${cwd}: ${stderr.trim() || `exited with code ${code}`}`)
  }
}
