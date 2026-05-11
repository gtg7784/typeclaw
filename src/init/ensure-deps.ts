import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runBunInstall } from './run-bun-install'

const PACKAGE_FILE = 'package.json'
const NODE_MODULES = 'node_modules'

export type EnsureDepsResult =
  | { ok: true; installed: boolean }
  | { ok: false; reason: string; missing?: readonly string[] }

export type EnsureDepsOptions = {
  cwd: string
  install?: (cwd: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  detect?: (cwd: string) => Promise<readonly string[]>
}

// Walks <cwd>/package.json plus one level of transitive deps via
// <cwd>/node_modules/<dep>/package.json. The canonical failure we guard
// against: typeclaw is installed, but its own deps (e.g. agent-messenger,
// zod) aren't hoisted to the agent folder after a CLI upgrade added them.
// Direct deps alone wouldn't catch that — typeclaw IS present, but its
// dependencies field has grown. Deeper drift (dep-of-dep-of-dep missing) is
// rare and surfaces during `bun install` anyway.
export async function ensureDepsInstalled(options: EnsureDepsOptions): Promise<EnsureDepsResult> {
  const { cwd } = options
  const install = options.install ?? runBunInstall
  const detect = options.detect ?? detectMissingDeps

  const missing = await detect(cwd)
  if (missing.length === 0) return { ok: true, installed: false }

  const result = await install(cwd)
  if (!result.ok) return { ok: false, reason: result.reason, missing }

  // Re-probe: `bun install` returns 0 even when a file:-linked dep's own
  // package.json is unreachable (it silently no-ops on the target). Without
  // this check, we'd proceed to `docker run` with a known-broken
  // node_modules/ and the agent would crash with a confusing in-container
  // `Cannot find package 'x'`.
  const stillMissing = await detect(cwd)
  if (stillMissing.length > 0) {
    return {
      ok: false,
      reason: `bun install completed but these deps are still missing from ${cwd}/node_modules/: ${stillMissing.join(', ')}`,
      missing: stillMissing,
    }
  }
  return { ok: true, installed: true }
}

export async function detectMissingDeps(cwd: string): Promise<readonly string[]> {
  const rootDeps = await readDeclaredDeps(join(cwd, PACKAGE_FILE))
  if (rootDeps.length === 0) return []

  const missing = new Set<string>()
  for (const dep of rootDeps) {
    if (!isInstalled(cwd, dep)) {
      missing.add(dep)
    }
  }

  for (const dep of rootDeps) {
    if (missing.has(dep)) continue
    const transitive = await readDeclaredDeps(join(cwd, NODE_MODULES, dep, PACKAGE_FILE))
    for (const t of transitive) {
      if (!isInstalled(cwd, t)) {
        missing.add(t)
      }
    }
  }

  return [...missing].sort()
}

async function readDeclaredDeps(packageJsonPath: string): Promise<readonly string[]> {
  if (!existsSync(packageJsonPath)) return []
  let raw: string
  try {
    raw = await readFile(packageJsonPath, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const deps = (parsed as { dependencies?: unknown }).dependencies
  if (deps === null || typeof deps !== 'object') return []
  return Object.keys(deps as Record<string, unknown>)
}

function isInstalled(cwd: string, depName: string): boolean {
  // Probe via the dep's package.json — NOT the directory — so symlinked
  // workspace and file:-linked deps (which resolve through a symlink to a
  // real package.json) count as installed.
  return existsSync(join(cwd, NODE_MODULES, depName, PACKAGE_FILE))
}
