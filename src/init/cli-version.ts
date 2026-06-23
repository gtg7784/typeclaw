import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { isWindows } from '@/shared/platform'

// Single source of truth for "what version of typeclaw is this agent on,
// and where does that mean we should pin the base image / write the dep
// spec." Sync I/O at module load — relative paths are stable in both a dev
// checkout and a real install, so the parent-walk an earlier draft used
// was unnecessary side effect. See AGENTS.md "Rules of thumb" for the
// install-vs-dev distinction this module encodes.

export const GHCR_BASE_IMAGE_REPO = 'ghcr.io/typeclaw/typeclaw-base'

const CLI_PACKAGE_JSON_PATH = join(import.meta.dir, '..', '..', 'package.json')

const cliPkg = JSON.parse(readFileSync(CLI_PACKAGE_JSON_PATH, 'utf8')) as { name?: string; version?: string }
if (cliPkg.name !== 'typeclaw' || typeof cliPkg.version !== 'string') {
  throw new Error(`Expected typeclaw package.json at ${CLI_PACKAGE_JSON_PATH}, got name=${cliPkg.name}`)
}

export const CLI_VERSION = cliPkg.version

const NODE_MODULES_SEGMENT = `${join('/', 'node_modules', '/')}`

export function isInstalledCli(): boolean {
  return CLI_PACKAGE_JSON_PATH.includes(NODE_MODULES_SEGMENT)
}

// `^X.Y.Z` when the invoking CLI is itself an installed copy of typeclaw
// (suitable for writing into a freshly-scaffolded agent's package.json),
// `null` when the CLI is running from the source repo (caller falls back
// to `file:` so the agent tracks the local checkout).
export function resolveScaffoldVersion(): string | null {
  if (!isInstalledCli()) return null
  return `^${CLI_VERSION}`
}

const TYPECLAW_PACKAGE = 'typeclaw'

// The local typeclaw source checkout this CLI runs from (the dir holding the
// CLI's own package.json), or null when the CLI is an installed package.
export function typeclawCheckoutRoot(): string | null {
  return isInstalledCli() ? null : dirname(CLI_PACKAGE_JSON_PATH)
}

// The `dependencies.typeclaw` spec a fresh/reconciled agent should declare to
// track the running CLI: `^X.Y.Z` when the CLI is an installed package, else the
// local checkout — `link:typeclaw` on native Windows (a `bun link` registration
// bun symlinks instead of copying; `file:` would copy the whole checkout incl
// `.git/` and EPERM, the #899 path) and `file:<rel>` on POSIX.
export function resolveTypeclawSpec(agentRoot: string, platform: NodeJS.Platform = process.platform): string {
  const scaffoldVersion = resolveScaffoldVersion()
  if (scaffoldVersion !== null) return scaffoldVersion
  if (isWindows(platform)) return `link:${TYPECLAW_PACKAGE}`
  const checkout = typeclawCheckoutRoot()
  return checkout ? `file:${toFileSpec(relative(agentRoot, checkout))}` : 'file:../typeclaw'
}

function toFileSpec(rel: string): string {
  if (rel === '') return '.'
  // bun/npm accept POSIX-style paths in file: specifiers; normalize separators.
  return rel.split(/[\\/]/).join('/')
}

// The version of typeclaw the AGENT will actually run inside the container.
// Prefers `<agent>/node_modules/typeclaw/package.json#version` because that
// is what the bind-mount exposes to the container at /agent/node_modules,
// and we want the base image's CLI version to match the runtime's. Falls
// back to parsing the agent's `dependencies.typeclaw` spec for fresh inits
// where `bun install` hasn't run yet, and to `null` when neither maps to
// a release version (dev mode, ranges, dist-tags, etc.).
export function resolveBaseImageVersion(agentDir: string): string | null {
  return readInstalledTypeclawVersion(agentDir) ?? readVersionFromDepSpec(agentDir)
}

function readInstalledTypeclawVersion(agentDir: string): string | null {
  try {
    const raw = readFileSync(join(agentDir, 'node_modules', 'typeclaw', 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    if (typeof parsed.version === 'string' && isReleaseVersion(parsed.version)) return parsed.version
  } catch {}
  return null
}

function readVersionFromDepSpec(agentDir: string): string | null {
  try {
    const raw = readFileSync(join(agentDir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> }
    const spec = parsed.dependencies?.typeclaw
    if (typeof spec !== 'string') return null
    return extractReleaseVersionFromSpec(spec)
  } catch {
    return null
  }
}

// Accept only specs that name an exact release version we can map 1:1 to a
// GHCR tag (`X.Y.Z`, `^X.Y.Z`, `~X.Y.Z`, `=X.Y.Z`). Reject ranges, `latest`,
// `*`, dist-tags, `workspace:` / `git:` / `portal:` / `npm:` aliases. Being
// strict here delays versioned pinning rather than silently picking the
// wrong tag — the installed-typeclaw check above is the primary path.
function extractReleaseVersionFromSpec(spec: string): string | null {
  const match = spec.trim().match(/^[\^~=]?(\d+\.\d+\.\d+)$/)
  return match ? (match[1] ?? null) : null
}

function isReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}
