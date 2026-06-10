import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { PACKAGE_FILE } from './packagejson'
import { PACKAGES_DIR } from './paths'

// The hostd restart path is destroy-then-recreate: it `docker rm -f`s the live
// container BEFORE `start()` runs `bun install`. A bad agent edit to
// typeclaw.json#plugins or a packages/* manifest aborts that install AFTER the
// old container is gone, with no rollback and no client to report to — the agent
// self-locks out. This runs BEFORE stop() (via RestartPreflight) so a bad edit
// becomes "restart refused, agent keeps running" instead of "agent bricked".
//
// Mirrors PR #770: ONLY deterministic local config errors block. No bun
// invocation, no network — a transient registry hiccup must never strand a
// healthy agent. start() stays the real fail-closed gate for everything else.

export type RestartDepsPreflightResult = { ok: true } | { ok: false; reason: string }

export type RestartDepsPreflightOptions = {
  cwd: string
  plugins: readonly string[]
}

const WORKSPACE_PROTOCOL = 'workspace:'

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

export async function validateRestartDeps(options: RestartDepsPreflightOptions): Promise<RestartDepsPreflightResult> {
  const { cwd, plugins } = options

  const localPluginError = checkLocalPluginPaths(cwd, plugins)
  if (localPluginError) return { ok: false, reason: localPluginError }

  const workspaceError = await checkWorkspaceMembers(cwd)
  if (workspaceError) return { ok: false, reason: workspaceError }

  return { ok: true }
}

// Mirrors loadLocal() in src/plugin/loader.ts: a local plugin entry is resolved
// against cwd and confined to it (`rel.startsWith('..') || isAbsolute(rel)`
// throws). An escaping entry (`../x`, `/abs/x`) that happens to EXIST passes a
// bare existsSync but the loader rejects it post-stop — so the escape check must
// run before, and independently of, the existence check.
function checkLocalPluginPaths(cwd: string, plugins: readonly string[]): string | null {
  for (const entry of plugins) {
    if (!isLocalEntry(entry)) continue
    const resolved = resolve(cwd, entry)
    const rel = relative(cwd, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return `local plugin "${entry}" referenced in typeclaw.json#plugins escapes the agent directory; the plugin loader confines local plugins to the agent folder and would reject it after the container has stopped. Use a path inside the agent folder before restarting.`
    }
    if (!existsSync(resolved)) {
      return `local plugin "${entry}" referenced in typeclaw.json#plugins does not exist on disk; restart would fail at dependency install. Remove the entry or restore the path before restarting.`
    }
  }
  return null
}

function isLocalEntry(entry: string): boolean {
  return entry.startsWith('./') || entry.startsWith('../') || isAbsolute(entry)
}

// Bun resolves the `workspace:` protocol strictly against the local workspace
// set, so a member declaring `"<dep>": "workspace:*"` where `<dep>` is not
// itself a workspace member aborts the WHOLE install with `<dep>@workspace:*
// failed to resolve`. Canonical trigger: a half-migrated local plugin still
// pinning `"typeclaw": "workspace:*"` after typeclaw became an external npm dep.
async function checkWorkspaceMembers(cwd: string): Promise<string | null> {
  const members = await readWorkspaceMembers(cwd)
  if (members.length === 0) return null

  const memberNames = new Set<string>()
  for (const m of members) {
    if (m.name !== null) memberNames.add(m.name)
  }

  for (const member of members) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = member.deps[field]
      if (!deps) continue
      for (const [depName, spec] of Object.entries(deps)) {
        if (!spec.startsWith(WORKSPACE_PROTOCOL)) continue
        if (!memberNames.has(depName)) {
          return `local workspace package "${member.dirName}" depends on "${depName}": "${spec}", but "${depName}" is not a workspace package under ${PACKAGES_DIR}/. \`bun install\` would abort with "${depName}@${spec} failed to resolve", leaving the agent unable to restart. Fix ${PACKAGES_DIR}/${member.dirName}/${PACKAGE_FILE} (use a registry version range, or remove the package) before restarting.`
        }
      }
    }
  }

  return null
}

type WorkspaceMember = {
  dirName: string
  name: string | null
  deps: Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>
}

// A member whose manifest is missing/unparseable is skipped, not failed: bun may
// tolerate it, and we only block on the workspace-resolution class above. No
// packages/ dir at all returns [].
async function readWorkspaceMembers(cwd: string): Promise<WorkspaceMember[]> {
  const packagesDir = join(cwd, PACKAGES_DIR)
  let entries: string[]
  try {
    entries = await readdir(packagesDir)
  } catch {
    return []
  }

  const members: WorkspaceMember[] = []
  for (const dirName of entries) {
    const manifestPath = join(packagesDir, dirName, PACKAGE_FILE)
    if (!existsSync(manifestPath)) continue
    let raw: string
    try {
      raw = await readFile(manifestPath, 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const pkg = parsed as Record<string, unknown>
    members.push({
      dirName,
      name: typeof pkg.name === 'string' ? pkg.name : null,
      deps: extractDeps(pkg),
    })
  }
  return members
}

function extractDeps(
  pkg: Record<string, unknown>,
): Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>> {
  const out: Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>> = {}
  for (const field of DEPENDENCY_FIELDS) {
    const value = pkg[field]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const deps: Record<string, string> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') deps[k] = v
    }
    if (Object.keys(deps).length > 0) out[field] = deps
  }
  return out
}
