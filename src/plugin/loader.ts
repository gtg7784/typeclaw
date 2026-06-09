import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { DefinedPlugin } from './types'

export type ResolvedPlugin = {
  name: string
  version: string | undefined
  source: string
  defined: DefinedPlugin<any>
}

export type LoadPluginEntryFn = (entry: string, agentDir: string) => Promise<ResolvedPlugin>

// Thrown only when a plugin entry cannot be resolved at all (uninstalled
// package, missing local file, unresolvable export subpath). The manager
// treats this as non-fatal and skips the entry. Every other failure --
// path-escape, import-time evaluation throws, invalid definition -- stays a
// plain Error so it remains a hard boot error.
export class PluginNotFoundError extends Error {
  readonly entry: string
  constructor(entry: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PluginNotFoundError'
    this.entry = entry
  }
}

export async function loadPluginEntry(entry: string, agentDir: string): Promise<ResolvedPlugin> {
  if (isLocalPath(entry)) {
    return loadLocal(entry, agentDir)
  }
  return loadNpm(entry, agentDir)
}

function isLocalPath(entry: string): boolean {
  return entry.startsWith('./') || entry.startsWith('../') || isAbsolute(entry)
}

async function loadLocal(entry: string, agentDir: string): Promise<ResolvedPlugin> {
  const resolved = resolve(agentDir, entry)
  // Confine local plugin paths to within agentDir so a malicious typeclaw.json
  // cannot point at arbitrary files on the host.
  const rel = relative(agentDir, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`plugin path escapes agent directory: ${entry} (resolved to ${resolved})`)
  }
  if (!existsSync(resolved)) {
    throw new PluginNotFoundError(entry, `plugin path does not exist: ${entry} (resolved to ${resolved})`)
  }
  const url = pathToFileURL(resolved).href
  const mod = (await import(url)) as { default?: unknown }
  const defined = expectDefined(mod, entry)
  const name = basename(resolved).replace(/\.(ts|tsx|js|mjs|cjs)$/i, '')
  return { name, version: undefined, source: entry, defined }
}

async function loadNpm(entry: string, agentDir: string): Promise<ResolvedPlugin> {
  const pkgJsonPath = findPackageJson(entry, agentDir)
  let pkgName = entry
  let version: string | undefined
  let entryPath: string | null = null
  if (pkgJsonPath !== null) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        name?: unknown
        version?: unknown
        main?: unknown
        module?: unknown
      }
      if (typeof pkg.name === 'string' && pkg.name.length > 0) pkgName = pkg.name
      if (typeof pkg.version === 'string' && pkg.version.length > 0) version = pkg.version
      const main = typeof pkg.module === 'string' ? pkg.module : typeof pkg.main === 'string' ? pkg.main : null
      if (main !== null) {
        const candidate = join(dirname(pkgJsonPath), main)
        if (existsSync(candidate)) {
          entryPath = candidate
        }
      }
    } catch {
      // Fall through to bare-import resolution.
    }
  }
  // Resolve before importing so an unresolvable entry (uninstalled package,
  // missing export subpath) is classified as PluginNotFoundError WITHOUT
  // running the module. Once resolution succeeds, any import-time throw is a
  // genuine plugin bug and propagates fatally -- never swallowed as not-found.
  // The entryPath branch covers packages whose `main`/`module` was already
  // located on disk; the else branch lets Bun's resolver read `exports` maps.
  let importTarget: string
  if (entryPath !== null) {
    importTarget = pathToFileURL(entryPath).href
  } else {
    try {
      importTarget = Bun.resolveSync(entry, agentDir)
    } catch (err) {
      throw new PluginNotFoundError(entry, `cannot resolve plugin "${entry}": ${describeError(err)}`, { cause: err })
    }
  }
  const mod = (await import(importTarget)) as { default?: unknown }
  const defined = expectDefined(mod, entry)
  const name = derivePluginNameFromPackage(pkgName)
  return { name, version, source: entry, defined }
}

export function derivePluginNameFromPackage(packageName: string): string {
  const PREFIX = 'typeclaw-plugin-'
  const SCOPED_PREFIX_RE = /^@[^/]+\//
  const stripped = packageName.replace(SCOPED_PREFIX_RE, '')
  return stripped.startsWith(PREFIX) ? stripped.slice(PREFIX.length) : stripped
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function findPackageJson(entry: string, agentDir: string): string | null {
  const PACKAGE_JSON = 'package.json'
  let cur = agentDir
  while (true) {
    const p = join(cur, 'node_modules', entry, PACKAGE_JSON)
    if (existsSync(p)) return p
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

function expectDefined(mod: { default?: unknown }, entry: string): DefinedPlugin<any> {
  const def = mod.default
  if (
    def !== null &&
    typeof def === 'object' &&
    'plugin' in (def as Record<string, unknown>) &&
    typeof (def as { plugin: unknown }).plugin === 'function'
  ) {
    return def as DefinedPlugin<any>
  }
  throw new Error(`plugin ${entry}: default export is not a definePlugin(...) result`)
}
