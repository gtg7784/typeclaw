import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { splitPluginEntrySpec } from '@/plugin'

const PACKAGE_FILE = 'package.json'

export type ReconcilePluginDepsResult = {
  changed: boolean
  files: string[]
}

export type ResolveLatestVersion = (packageName: string) => Promise<string>

export type ReconcilePluginDepsOptions = {
  cwd: string
  plugins: readonly string[]
  resolveLatest?: ResolveLatestVersion
}

// Materializes typeclaw.json#plugins into package.json#dependencies so the
// plugin list is the single source of truth: the user edits typeclaw.json and
// `start` keeps package.json in sync. The sync is one-way (config → manifest)
// and bidirectional in effect (entries added to config are written; entries
// removed from config are pruned). Provenance lives in
// package.json#typeclaw.managedPlugins so pruning only ever touches deps this
// step added — never the user's own dependencies or the typeclaw runtime dep.
export async function reconcilePluginDeps(options: ReconcilePluginDepsOptions): Promise<ReconcilePluginDepsResult> {
  const { cwd, plugins } = options
  const resolveLatest = options.resolveLatest ?? resolveLatestFromRegistry

  const pkgPath = join(cwd, PACKAGE_FILE)
  if (!existsSync(pkgPath)) return { changed: false, files: [] }

  let raw: string
  try {
    raw = await readFile(pkgPath, 'utf8')
  } catch {
    return { changed: false, files: [] }
  }

  let pkg: PackageJsonShape
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { changed: false, files: [] }
    pkg = parsed as PackageJsonShape
  } catch {
    return { changed: false, files: [] }
  }

  const desired = await resolveDesiredManaged(plugins, resolveLatest)
  const dependencies = { ...pkg.dependencies }
  const previousManaged = readManagedPlugins(pkg)

  let changed = false

  for (const [name, version] of Object.entries(desired)) {
    if (dependencies[name] !== version) {
      dependencies[name] = version
      changed = true
    }
  }

  // Prune scoped strictly to the prior managed set: a dep the user hand-added
  // or a runtime dep is never removed even if its name shape looks plugin-like.
  for (const name of Object.keys(previousManaged)) {
    if (!(name in desired) && name in dependencies) {
      delete dependencies[name]
      changed = true
    }
  }

  if (!managedEqual(previousManaged, desired)) changed = true

  if (!changed) return { changed: false, files: [] }

  const next = withManagedPlugins({ ...pkg, dependencies: sortKeys(dependencies) }, desired)
  await writeFile(pkgPath, `${JSON.stringify(next, null, 2)}\n`)
  return { changed: true, files: [PACKAGE_FILE] }
}

type PackageJsonShape = {
  dependencies?: Record<string, string>
  typeclaw?: { managedPlugins?: Record<string, string> } & Record<string, unknown>
} & Record<string, unknown>

// Classifies config.plugins entries and resolves the version each managed dep
// should pin to. Local paths and bundled-style entries are not npm packages, so
// they are skipped. A bare name resolves its current latest version once and
// pins it, mirroring `npm/bun add <name>` writing a concrete version.
async function resolveDesiredManaged(
  plugins: readonly string[],
  resolveLatest: ResolveLatestVersion,
): Promise<Record<string, string>> {
  const desired: Record<string, string> = {}
  for (const entry of plugins) {
    if (isLocalEntry(entry)) continue
    const { name, versionSpec } = splitPluginEntrySpec(entry)
    if (name.length === 0) continue
    desired[name] = versionSpec ?? (await resolveLatest(name))
  }
  return sortKeys(desired)
}

function isLocalEntry(entry: string): boolean {
  return entry.startsWith('./') || entry.startsWith('../') || isAbsolute(entry)
}

function readManagedPlugins(pkg: PackageJsonShape): Record<string, string> {
  const managed = pkg.typeclaw?.managedPlugins
  if (managed === undefined || managed === null || typeof managed !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [name, version] of Object.entries(managed)) {
    if (typeof version === 'string') out[name] = version
  }
  return out
}

function withManagedPlugins(pkg: PackageJsonShape, managed: Record<string, string>): PackageJsonShape {
  const typeclaw = { ...pkg.typeclaw }
  if (Object.keys(managed).length === 0) {
    delete typeclaw.managedPlugins
  } else {
    typeclaw.managedPlugins = managed
  }
  if (Object.keys(typeclaw).length === 0) {
    const { typeclaw: _omit, ...rest } = pkg
    return rest as PackageJsonShape
  }
  return { ...pkg, typeclaw }
}

function managedEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k] as string
  return out
}

async function resolveLatestFromRegistry(packageName: string): Promise<string> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) throw new Error(`cannot resolve latest version for ${packageName}: bun runtime not available`)
  const proc = bun.spawn({
    cmd: ['bun', 'pm', 'view', packageName, 'version'],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`failed to resolve latest version for ${packageName}: ${stderr.trim() || `exit ${code}`}`)
  }
  const version = (await new Response(proc.stdout).text()).trim().replace(/^["']|["']$/g, '')
  if (version.length === 0) throw new Error(`registry returned no version for ${packageName}`)
  return version
}
