import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type UpdateManager = 'bun' | 'npm' | 'pnpm' | 'yarn'
export type UpdateManagerSelection = 'auto' | UpdateManager
export type UpdateScope = 'global' | 'local'

export type SelfUpdatePlan =
  | { ok: true; manager: UpdateManager; scope: UpdateScope; command: string[]; detectedFrom: string; cwd?: string }
  | { ok: false; reason: string }

export type DetectedInstall = {
  manager: UpdateManager
  scope: UpdateScope
  // Defined only for local installs: the directory whose `node_modules/` owns
  // the installed copy (i.e. where `bun update` / `npm install` must run).
  installRoot?: string
}

export type PlanOptions = {
  manager: UpdateManagerSelection
  packageJsonPath?: string
  // Test seam: probes a candidate file's existence (defaults to `node:fs.existsSync`).
  // Only consulted to pick a manager for local installs from a project lockfile.
  fileExists?: (path: string) => boolean
}

export function resolveSelfPackageJsonPath(): string {
  return join(import.meta.dir, '..', '..', 'package.json')
}

export function planSelfUpdate(options: PlanOptions): SelfUpdatePlan {
  const packageJsonPath = options.packageJsonPath ?? resolveSelfPackageJsonPath()
  const fileExists = options.fileExists ?? existsSync
  const detected = detectInstall(packageJsonPath, fileExists)

  if (options.manager === 'auto') {
    if (detected === null) {
      return {
        ok: false,
        reason:
          'Cannot auto-detect how TypeClaw was installed from this checkout. Re-run with --manager=bun, --manager=npm, --manager=pnpm, or --manager=yarn if you want to update a global install.',
      }
    }
    return buildPlan(detected, packageJsonPath)
  }

  // Explicit manager. Honor the detected scope when we know it (so an explicit
  // --manager on a local install doesn't surprise users by silently going
  // global); fall back to a global update for source checkouts and other
  // unrecognized layouts, matching the historical behavior.
  const scope: UpdateScope = detected?.scope ?? 'global'
  const installRoot =
    scope === 'local' ? (detected?.installRoot ?? installRootFrom(packageJsonPath) ?? undefined) : undefined
  return buildPlan({ manager: options.manager, scope, installRoot }, packageJsonPath)
}

export function commandForInstall(manager: UpdateManager, scope: UpdateScope): string[] {
  switch (manager) {
    case 'bun':
      return scope === 'global'
        ? ['bun', 'update', '-g', 'typeclaw', '--latest']
        : ['bun', 'update', 'typeclaw', '--latest']
    case 'npm':
      return scope === 'global' ? ['npm', 'install', '-g', 'typeclaw@latest'] : ['npm', 'install', 'typeclaw@latest']
    case 'pnpm':
      return scope === 'global' ? ['pnpm', 'add', '-g', 'typeclaw@latest'] : ['pnpm', 'add', 'typeclaw@latest']
    case 'yarn':
      return scope === 'global'
        ? ['yarn', 'global', 'upgrade', 'typeclaw', '--latest']
        : ['yarn', 'upgrade', 'typeclaw', '--latest']
  }
}

export function formatCommand(command: readonly string[]): string {
  return command.map(shellQuote).join(' ')
}

function buildPlan(detected: DetectedInstall, packageJsonPath: string): SelfUpdatePlan {
  return {
    ok: true,
    manager: detected.manager,
    scope: detected.scope,
    command: commandForInstall(detected.manager, detected.scope),
    detectedFrom: packageJsonPath,
    ...(detected.installRoot ? { cwd: detected.installRoot } : {}),
  }
}

function detectInstall(packageJsonPath: string, fileExists: (path: string) => boolean): DetectedInstall | null {
  const parts = packageJsonPath.split(/[\\/]+/).filter(Boolean)
  const packageJson = parts[parts.length - 1]
  const packageName = parts[parts.length - 2]
  const nodeModulesIdx = parts.lastIndexOf('node_modules')
  if (packageJson !== 'package.json' || packageName !== 'typeclaw' || nodeModulesIdx === -1) return null

  // Bun global: .bun/install/global/node_modules/typeclaw
  const bunGlobalIdx = parts.lastIndexOf('.bun')
  if (
    bunGlobalIdx !== -1 &&
    parts[bunGlobalIdx + 1] === 'install' &&
    parts[bunGlobalIdx + 2] === 'global' &&
    parts[bunGlobalIdx + 3] === 'node_modules'
  ) {
    return { manager: 'bun', scope: 'global' }
  }

  // pnpm shards globals under a numeric major-version segment, e.g.
  // ~/Library/pnpm/global/5/node_modules or legacy ~/.pnpm-global/5/node_modules.
  if (nodeModulesIdx >= 2 && /^\d+$/.test(parts[nodeModulesIdx - 1] ?? '')) {
    const anchor = parts[nodeModulesIdx - 2]
    if (anchor === 'pnpm-global' || anchor === '.pnpm-global') return { manager: 'pnpm', scope: 'global' }
    if (anchor === 'global' && parts[nodeModulesIdx - 3] === 'pnpm') return { manager: 'pnpm', scope: 'global' }
  }

  if (nodeModulesIdx >= 2 && parts[nodeModulesIdx - 1] === 'global' && parts[nodeModulesIdx - 2] === 'yarn') {
    return { manager: 'yarn', scope: 'global' }
  }

  if (parts[nodeModulesIdx - 1] === 'lib') return { manager: 'npm', scope: 'global' }

  const installRoot = installRootFrom(packageJsonPath)
  if (installRoot === null) return null
  return { manager: detectLocalManager(installRoot, fileExists), scope: 'local', installRoot }
}

function installRootFrom(packageJsonPath: string): string | null {
  const sepMatch = packageJsonPath.match(/[\\/]/)
  const sep = sepMatch?.[0] ?? '/'
  const parts = packageJsonPath.split(/[\\/]+/)
  const nodeModulesIdx = parts.lastIndexOf('node_modules')
  if (nodeModulesIdx <= 0) return null
  const head = parts.slice(0, nodeModulesIdx)
  // Preserve a leading separator on POSIX paths (`/usr/lib/...` splits to
  // `['', 'usr', 'lib', ...]`) and Windows drive prefixes (`C:\Users\...`
  // splits to `['C:', 'Users', ...]`, no leading empty).
  return head.length === 1 && head[0] === '' ? sep : head.join(sep)
}

// Prefer the lockfile present in the install root. Probe order is bun -> pnpm
// -> yarn -> npm so a project with multiple lockfiles checked in (a real,
// gross-but-common scenario during migrations) lands on bun, matching this
// repo's default. The CLI's `--manager` flag always wins over this heuristic.
function detectLocalManager(installRoot: string, fileExists: (path: string) => boolean): UpdateManager {
  if (fileExists(join(installRoot, 'bun.lock')) || fileExists(join(installRoot, 'bun.lockb'))) return 'bun'
  if (fileExists(join(installRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fileExists(join(installRoot, 'yarn.lock'))) return 'yarn'
  if (fileExists(join(installRoot, 'package-lock.json'))) return 'npm'
  return 'bun'
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", "'\\''")}'`
}
